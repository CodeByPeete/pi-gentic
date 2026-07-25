import { Schema } from "effect";
import { SessionManager, type AgentToolUpdateCallback, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AGENT_CYCLE_SHORTCUT,
  activeStateDiagnostics,
  enabledModelPatterns,
  findAvailableSkill,
  getErrorMessage,
  isRecord,
  loadAvailableSkills,
  loadConfiguration,
  loadPiSettings,
  shortSessionId,
  systemPromptSkillEntries,
} from "./catalog.js";
import {
  buildManualSkillMessage,
  completeAgents,
  completeSend,
  completeSkill,
  isCompletingSendSession,
  parseAgentCommand,
  parseSendCommand,
  parseSkillCommand,
} from "./interface.js";
import { readRuntimeDiagnostics, reportRuntimeDiagnostic } from "./diagnostics.js";
import {
  AgentsToolParametersSchema,
  agentsActionName,
  normalizeAgentsToolInput,
  type AgentsToolInput,
} from "./domain/agents-tool.js";
import { hostCompatibilityDiagnostics, installLiveSessionBridge, setActiveVisibleExtension } from "./pi-host.js";
import { PiGenticOrchestrator } from "./orchestration.js";
import type { PiApi, PiContext, UnknownRecord } from "./pi-types.js";
import { createExtensionRuntime, shouldDisposeExtensionRuntime } from "./runtime/ExtensionRuntime.js";
import { installResumeBridge } from "./resume.js";
import { buildSessionTree, enrichSessionSummaries, findSessionSummary, sessionCompletionScope } from "./sessions.js";
import {
  renderAgentsCall,
  renderAgentsResult,
  restorePersistedCardDetails,
  showCard,
  startSessionLiveCardRefresh,
} from "./ui.js";

const AgentsToolParameters = Schema.toJsonSchemaDocument(AgentsToolParametersSchema);

function showErrorCard(pi: PiApi, orchestrator: PiGenticOrchestrator, error: unknown, kind = "error") {
  const message = getErrorMessage(error);

  showCard(pi, message, orchestrator.cardDetails(kind, "error", { error: message }));
}

export default async function piGentic(pi: ExtensionAPI) {
  const runtime = createExtensionRuntime();

  await installLiveSessionBridge();
  await installResumeBridge(runtime);
  const orchestrator = new PiGenticOrchestrator(pi, runtime);
  const completionContext = createCompletionContext(pi);
  let runtimeDisposed = false;

  pi.on("session_shutdown", async (event) => {
    if (runtimeDisposed || !shouldDisposeExtensionRuntime(event.reason)) return;
    runtimeDisposed = true;
    await runtime.dispose();
  });

  pi.registerMessageRenderer<UnknownRecord>("pi-gentic:card", (message, options, theme) => {
    const component = renderAgentsResult(
      {
        content: [
          {
            type: "text",
            text: typeof message.content === "string" ? message.content : "",
          },
        ],
        details: message.details,
      },
      { expanded: options.expanded, isPartial: false },
      theme,
      { args: {}, isError: message.details?.status === "error" },
    );

    return component;
  });

  let stopSessionLiveCardRefresh: (() => void) | undefined;

  pi.on("session_start", async (event, ctx) => {
    setActiveVisibleExtension(pi, ctx);
    stopSessionLiveCardRefresh?.();
    restorePersistedCardDetails(ctx.sessionManager);
    stopSessionLiveCardRefresh = startSessionLiveCardRefresh(ctx, runtime);
    completionContext.capture(ctx);
    reportDiagnostics(pi, ctx);
    try {
      const defaultResult = await orchestrator.loadDefaultAgent(ctx, event);

      if (defaultResult) showCard(pi, defaultResult.text, defaultResult.details);
      else await orchestrator.applyCurrentPolicy(ctx);
    } catch (error) {
      ctx.ui.notify(`pi-gentic: ${getErrorMessage(error)}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    stopSessionLiveCardRefresh?.();
    stopSessionLiveCardRefresh = undefined;
  });

  pi.registerShortcut(AGENT_CYCLE_SHORTCUT, {
    description: "Cycle pi-gentic active agent",
    handler: async (ctx) => {
      completionContext.capture(ctx);
      try {
        const result = await orchestrator.cycleAgent(ctx);
        showCard(pi, result.text, result.details);
      } catch (error) {
        showErrorCard(pi, orchestrator, error);
      }
    },
  });

  pi.on("agent_start", async (_event, ctx) => {
    orchestrator.setTitle(ctx, true);
  });

  pi.on("agent_end", async (_event, ctx) => {
    orchestrator.setTitle(ctx, false);
  });

  pi.on("input", (_event, ctx) => {
    orchestrator.prepareVisibleTurn(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => orchestrator.buildPromptAppend(ctx, event));

  pi.registerCommand("agent", {
    description: "Set, clear, or show the active pi-gentic agent",
    getArgumentCompletions: (prefix) => completeAgents(prefix, orchestrator.currentAgentName),
    handler: async (args, ctx) => {
      completionContext.capture(ctx);
      const parsed = parseAgentCommand(args);

      if (!parsed.agent) {
        const active = orchestrator.getActiveAgent(ctx);
        ctx.ui.notify(
          active ? `Active agent: ${active.name}\n${active.description ?? ""}` : "No active agent.",
          "info",
        );
        return;
      }

      try {
        if (parsed.sessionId) {
          const config = trustedConfiguration(ctx);
          const runtime = await orchestrator.getOrOpenSession(ctx, parsed.sessionId);

          if (parsed.agent === "clear") {
            runtime.session.sessionManager.appendCustomEntry("pi-gentic:state", { agentName: undefined });
            ctx.ui.notify(
              `Cleared active agent in session ${shortSessionId(runtime.session.sessionManager.getSessionId())}.`,
              "info",
            );
            return;
          }
          await orchestrator.loadAgentIntoSession(runtime.session, parsed.agent, undefined, config, ctx);
          ctx.ui.notify(
            `Loaded ${parsed.agent} in session ${shortSessionId(runtime.session.sessionManager.getSessionId())}.`,
            "info",
          );
          return;
        }

        const result = await orchestrator.loadAgent(ctx, parsed.agent);
        showCard(pi, result.text, result.details);
      } catch (error) {
        showErrorCard(pi, orchestrator, error);
      }
    },
  });

  pi.registerCommand("skill", {
    description: "Manually invoke a Pi skill: /skill <name> [request]",
    getArgumentCompletions: (prefix) => completeSkill(prefix, completionContext.current()),
    handler: async (args, ctx) => {
      completionContext.capture(ctx);
      const parsed = parseSkillCommand(args);

      if (!parsed.name) {
        ctx.ui.notify?.("Usage: /skill <name> [request]", "warning");
        return;
      }

      await invokeSkillCommand(pi, parsed.name, parsed.message, ctx);
    },
  });

  pi.registerCommand("send", {
    description: "Send a message to a pi-gentic child or target session",
    getArgumentCompletions: async (prefix) => {
      const snapshot = completionContext.current();

      if (!isCompletingSendSession(prefix)) return completeSend(prefix, snapshot);
      const sessions = await listCompletionSessions(snapshot);

      return completeSend(prefix, {
        cwd: snapshot.cwd,
        sessions,
        currentSessionId: snapshot.currentSessionId,
      });
    },
    handler: async (args, ctx) => {
      completionContext.capture(ctx);
      const parsed = parseSendCommand(args);

      if (typeof parsed.message !== "string" || !parsed.message.trim()) {
        ctx.ui.notify(
          "Usage: /send <message> [--agent <agentName>] [--session <sessionId>] [--fork] [--bg|--fg] [--no-invoke] [--cwd <dir>] [--worktree [branch]] [--repo <dir>] [override flags]",
          "warning",
        );
        return;
      }

      try {
        let showedProgress = false;
        const result = await orchestrator.send(
          ctx,
          { ...parsed, message: parsed.message },
          {
            awaitCompletion: false,
            onUpdate: (update: unknown) => {
              if (showedProgress) return;
              showedProgress = true;
              const result = isRecord(update) ? update : {};
              showCard(
                pi,
                firstText(result.content) ?? "Sending message...",
                isRecord(result.details) ? result.details : {},
              );
            },
          },
        );

        if (!showedProgress)
          showCard(
            pi,
            typeof result.text === "string" ? result.text : String(result.text ?? ""),
            isRecord(result.details) ? result.details : {},
          );
      } catch (error) {
        showErrorCard(pi, orchestrator, error, "send");
      }
    },
  });

  pi.registerTool({
    name: "agents",
    label: "Agents",
    description: [
      "Perform one pi-gentic orchestration action.",
      "Sessions are durable collaborators: when continuing, retrying, or referring to the same agent or same work, target a different existing sessionId instead of creating a new child session; create a new session only for independent work.",
      "Actions: list returns available agent names; get returns one agent definition and requires agent; status reports one session and requires sessionId; load sets the active agent and accepts agent plus optional overrides; send delivers message to a different existing sessionId or to a new child when no sessionId is supplied, with optional agent, async, fork, cwd, worktree, repo, invokeMeLater, and overrides; abort stops the current session or the supplied sessionId; discoverSessions returns nearby orchestration sessions and accepts rx and ry.",
      "Use one action per call. Do not send slash commands, prose wrappers, or shell commands as the action.",
    ].join(" "),
    promptSnippet:
      "Orchestrate durable pi-gentic agent sessions; reuse a different sessionId for the same agent or same work, and use actions list, get, status, load, send, abort, and discoverSessions",
    parameters: AgentsToolParameters,
    renderShell: "self",
    renderCall: renderAgentsCall,
    renderResult: renderAgentsResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      completionContext.capture(ctx);
      try {
        const input = await runtime.runPromise(normalizeAgentsToolInput(params));
        const result = await executeAction(orchestrator, ctx, input, onUpdate, signal);

        return {
          content: [
            {
              type: "text",
              text: typeof result.text === "string" ? result.text : String(result.text ?? ""),
            },
          ],
          details: result.details,
        };
      } catch (error) {
        const message = getErrorMessage(error);

        return {
          content: [{ type: "text", text: message }],
          details: orchestrator.cardDetails("error", "error", { error: message }),
          isError: true,
        };
      }
    },
  });
}

async function invokeSkillCommand(pi: PiApi, skillName: string, message: string, ctx: PiContext) {
  if (!skillCommandsEnabled(ctx)) {
    ctx.ui.notify?.("Pi skill commands are disabled by settings.", "warning");
    return;
  }
  const skill = findAvailableSkill(skillName, { cwd: ctx.cwd });

  if (!skill) {
    ctx.ui.notify?.(`Unknown Pi skill "${skillName}".`, "warning");
    return;
  }

  await pi.sendUserMessage(buildManualSkillMessage(skill, message));
}

function skillCommandsEnabled(ctx: PiContext) {
  return (
    loadPiSettings(undefined, ctx.cwd ?? process.cwd(), [], ctx.isProjectTrusted?.() === true).enableSkillCommands !==
    false
  );
}

type CompletionSnapshot = {
  cwd: string;
  sessionDir?: string;
  currentSessionId?: string;
  currentSessionPath?: string;
  agents: UnknownRecord[];
  models: UnknownRecord[];
  tools: string[];
  skills: string[];
  commands: UnknownRecord[];
  themes: string[];
  systemPromptFiles: string[];
};

function createCompletionContext(pi: PiApi, onCapture?: (snapshot: UnknownRecord, ctx?: PiContext) => void) {
  let snapshot: CompletionSnapshot = {
    cwd: process.cwd(),
    agents: [],
    models: [],
    tools: [],
    skills: [],
    commands: [],
    themes: [],
    systemPromptFiles: [],
  };

  return {
    capture(ctx: PiContext | undefined) {
      if (!ctx) return snapshot;
      const cwd = typeof ctx.cwd === "string" ? ctx.cwd : snapshot.cwd;
      const projectTrusted = ctx.isProjectTrusted?.() === true;
      const config = loadConfiguration({ cwd, projectTrusted });
      const nativeSkills = systemPromptSkillEntries(ctx);
      snapshot = {
        cwd,
        sessionDir: ctx.sessionManager?.getSessionDir?.() ?? snapshot.sessionDir,
        currentSessionId: ctx.sessionManager?.getSessionId?.() ?? snapshot.currentSessionId,
        currentSessionPath: ctx.sessionManager?.getSessionFile?.() ?? snapshot.currentSessionPath,
        agents: config.agents,
        models: scopedModelSuggestions(ctx),
        tools: safeToolNames(pi),
        skills: (nativeSkills.length > 0 ? nativeSkills : loadAvailableSkills({ cwd, projectTrusted })).map(
          (skill) => skill.name,
        ),
        commands: safeCommands(pi),
        themes: themeSuggestions(config),
        systemPromptFiles: systemPromptFileSuggestions(config),
      };
      onCapture?.(snapshot, ctx);

      return snapshot;
    },
    current() {
      return snapshot;
    },
  };
}

async function listCompletionSessions({
  cwd,
  sessionDir,
  currentSessionId,
  currentSessionPath,
}: {
  cwd: string;
  sessionDir?: string;
  currentSessionId?: string;
  currentSessionPath?: string;
}) {
  try {
    const persisted = await listCompletionSessionSources(cwd, sessionDir);
    const current =
      findSessionSummary(persisted, {
        id: currentSessionId,
        sessionId: currentSessionId,
        path: currentSessionPath,
      }) ??
      (currentSessionId || currentSessionPath
        ? {
            id: currentSessionId,
            sessionId: currentSessionId,
            path: currentSessionPath,
          }
        : undefined);
    const scoped = sessionCompletionScope(buildSessionTree(current, persisted), current, {
      rx: 4,
      ry: 4,
    });

    return enrichSessionSummaries(scoped, 20);
  } catch (error) {
    reportRuntimeDiagnostic("completion-sessions", error);
    return [];
  }
}

async function listCompletionSessionSources(cwd: string, sessionDir?: string) {
  const persisted = await SessionManager.list(cwd, sessionDir);

  return persisted.flatMap((session) => (isRecord(session) ? [session] : []));
}

function scopedModelSuggestions(ctx: PiContext | undefined) {
  const patterns = enabledModelPatterns() ?? [];
  const registry = ctx?.modelRegistry;
  const available = safeAvailableModels(registry);

  if (patterns.length === 0) return available;

  return patterns.map((pattern) => {
    const [provider, id] = String(pattern)
      .split(/\/(.*)/)
      .filter(Boolean);
    const match = provider && id ? registry?.find?.(provider, id) : undefined;

    return recordValue(match ?? { provider, id: id ?? pattern, label: pattern });
  });
}

function safeAvailableModels(modelRegistry: unknown): UnknownRecord[] {
  try {
    if (!isRecord(modelRegistry) || typeof modelRegistry.getAvailable !== "function") return [];
    const models = modelRegistry.getAvailable();

    return Array.isArray(models) ? models.filter(isRecord) : [];
  } catch (error) {
    reportRuntimeDiagnostic("available-models", error);
    return [];
  }
}

function safeToolNames(pi: PiApi) {
  try {
    return pi
      .getAllTools()
      .map((tool) => tool.name)
      .filter(Boolean);
  } catch (error) {
    reportRuntimeDiagnostic("available-tools", error);
    return [];
  }
}

function safeCommands(pi: PiApi): UnknownRecord[] {
  try {
    return (pi.getCommands?.() ?? []).map((command) =>
      recordValue({
        name: command.name,
        description: command.description,
      }),
    );
  } catch (error) {
    reportRuntimeDiagnostic("available-commands", error);
    return [];
  }
}

function systemPromptFileSuggestions(config: ReturnType<typeof loadConfiguration>) {
  const settings = recordValue(config.settings);
  const agentless = recordValue(settings.agentlessSession);
  const defaults = recordValue(settings.agentDefaults);
  const files = [
    ...toStringArray(agentless.systemPromptFiles),
    ...toStringArray(defaults.systemPromptFiles),
    ...config.agents.flatMap((agent: UnknownRecord) => toStringArray(agent.systemPromptFiles)),
  ];

  return files.filter((file, index) => files.indexOf(file) === index);
}

function recordValue(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function toStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function themeSuggestions(config: ReturnType<typeof loadConfiguration>) {
  const settings = recordValue(config.settings);
  const themes = [settings.theme, ...config.agents.map((agent) => agent.theme)].filter(
    (theme): theme is string => typeof theme === "string" && Boolean(theme),
  );

  return themes.filter((theme, index) => themes.indexOf(theme) === index);
}

async function executeAction(
  orchestrator: PiGenticOrchestrator,
  ctx: PiContext,
  input: AgentsToolInput,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  signal: AbortSignal | undefined,
) {
  if (input._tag === "ListAgentsAction") {
    const config = trustedConfiguration(ctx);
    const agents = orchestrator.availableAgents(ctx, config);
    const text =
      agents.map((agent: UnknownRecord) => `${agent.name}: ${agent.description ?? ""}`).join("\n") ||
      "No agents configured.";

    return {
      text,
      details: orchestrator.cardDetails("list", "done", {
        configuration: {
          agents: agents.map((agent: UnknownRecord) => agent.name),
        },
      }),
    };
  }

  if (input._tag === "GetAgentsAction") {
    if (!input.agent) throw new Error('Field "agent" is required for get.');
    const config = trustedConfiguration(ctx);
    const agent = orchestrator.availableAgents(ctx, config).find((item: UnknownRecord) => item.name === input.agent);

    if (!agent) throw new Error(`Unknown or unavailable agent "${input.agent}".`);
    return {
      text: JSON.stringify(agent, null, 2),
      details: orchestrator.cardDetails("get", "done", {
        agentName: agent.name,
        configuration: agent,
      }),
    };
  }

  if (input._tag === "StatusAgentsAction") {
    if (!input.sessionId) throw new Error('Field "sessionId" is required for status.');
    const status = await orchestrator.status(ctx, input.sessionId);

    return {
      text: status.text,
      details: orchestrator.cardDetails("status", "done", {
        sessionId: status.sessionId,
        configuration: status,
      }),
    };
  }

  if (input._tag === "LoadAgentsAction") {
    return orchestrator.loadAgent(ctx, input.agent, {
      overrides: input.overrides,
    });
  }

  if (input._tag === "SendAgentsAction") {
    if (typeof input.message !== "string" || !input.message.trim())
      throw new Error('Field "message" is required for send.');
    return orchestrator.send(ctx, { ...input }, { onUpdate, signal });
  }

  if (input._tag === "AbortAgentsAction") {
    const text = await orchestrator.abort(ctx, input.sessionId);

    return {
      text,
      details: orchestrator.cardDetails("abort", "done", {
        sessionId: input.sessionId,
      }),
    };
  }

  if (input._tag === "DiscoverSessionsAction") {
    const result = await orchestrator.discoverSessions(ctx, {
      rx: input.rx,
      ry: input.ry,
    });

    return {
      text: JSON.stringify(result, null, 2),
      details: orchestrator.cardDetails("discoverSessions", "done", {
        configuration: result,
        sessions: result.sessions,
      }),
    };
  }

  throw new Error(`Unknown action "${agentsActionName(input)}".`);
}

function reportDiagnostics(pi: ExtensionAPI, ctx: PiContext) {
  const projectTrusted = ctx.isProjectTrusted?.() === true;
  const diagnostics = [...loadConfiguration({ cwd: ctx.cwd, projectTrusted }).diagnostics];

  loadAvailableSkills({ cwd: ctx.cwd, diagnostics, projectTrusted });
  for (const message of hostCompatibilityDiagnostics()) diagnostics.push({ severity: "error", message });
  for (const message of activeStateDiagnostics()) diagnostics.push({ severity: "warning", message });
  for (const diagnostic of readRuntimeDiagnostics("warning"))
    diagnostics.push({
      severity: diagnostic.severity,
      message: `${diagnostic.scope}: ${diagnostic.message}`,
    });

  for (const diagnostic of diagnostics) {
    const location = diagnostic.path ? ` (${diagnostic.path})` : "";

    pi.events.emit("pi-gentic:diagnostic", diagnostic);
    if (diagnostic.severity === "debug") continue;
    ctx.ui.notify(`pi-gentic: ${diagnostic.message}${location}`, diagnostic.severity === "error" ? "error" : "warning");
  }
}

function trustedConfiguration(ctx: PiContext) {
  return loadConfiguration({
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted?.() === true,
  });
}

function firstText(content: unknown) {
  return Array.isArray(content) ? content.find((item) => item.type === "text")?.text : undefined;
}
