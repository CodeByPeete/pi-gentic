/**
 * Pi extension entrypoint.
 *
 * This file only wires Pi surfaces to the orchestrator: commands, shortcuts,
 * renderers, lifecycle events, and the model-callable agents tool.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getErrorMessage, shortSessionId } from "./core.js";
import {
  buildManualSkillMessage,
  completeAgents,
  completeSend,
  completeSkill,
  isCompletingSendSession,
  normalizeToolInput,
  parseAgentCommand,
  parseSendCommand,
  parseSkillCommand,
} from "./commands.js";
import {
  enabledModelPatterns,
  loadConfiguration,
  loadPiSettings,
} from "./config.js";
import { findAvailableSkill, loadAvailableSkills } from "./skills.js";
import { AGENT_CYCLE_SHORTCUT } from "./policy.js";
import { installLiveSessionBridge, persistSessionImmediately } from "./runtime.js";
import { PiGenticOrchestrator } from "./orchestrator.js";
import {
  buildSessionTree,
  cachedPersistedSessions,
  enrichSessionSummaries,
  findSessionSummary,
  listSessionSummariesFast,
  sessionCompletionScope,
  treeSwitchPath,
  warmPersistedSessions,
} from "./sessions.js";
import { persistSynchronousToolCard } from "./runs.js";
import {
  createSessionTreePicker,
  renderAgentsCall,
  renderAgentsResult,
  showCard,
  startLiveRefresh,
} from "./ui.js";

const AgentsToolParameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description:
        "One action: list, get, status, load, send, abort, discoverSessions",
    },
    agent: { type: "string" },
    sessionId: { type: "string" },
    message: { type: "string" },
    async: { type: "boolean" },
    fork: { type: "boolean" },
    cwd: {
      type: "string",
      description:
        "Working directory. When worktree is supplied, this is the worktree folder path.",
    },
    worktree: {
      type: "string",
      description:
        "Optional git worktree branch name. If empty, the folder name is used; if cwd is omitted too, pi-gentic derives a safe branch and folder from the message under .agentfiles/worktrees/.",
    },
    repo: {
      type: "string",
      description:
        "Repository to create the worktree from. Relative paths are resolved from the caller cwd. Defaults to the caller cwd.",
    },
    invokeMeLater: { type: "boolean" },
    overrides: { type: "object", additionalProperties: true },
    rx: { type: "number" },
    ry: { type: "number" },
  },
  required: ["action"],
};

/** Registers every pi-gentic surface with the host Pi process. */
export default function piGentic(pi) {
  installLiveSessionBridge();
  const orchestrator = new PiGenticOrchestrator(pi);
  let skillCommands: ReturnType<typeof createSkillCommandRegistry> | undefined;
  const completionContext = createCompletionContext(pi, (snapshot, ctx) =>
    skillCommands?.sync(
      ctx,
      Array.isArray(snapshot.skills) ? snapshot.skills : [],
    ),
  );
  skillCommands = createSkillCommandRegistry(pi, orchestrator, completionContext);
  skillCommands.sync(undefined, completionContext.current().skills);

  pi.registerMessageRenderer("pi-gentic:card", (message, options, theme) => {
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

  pi.on("session_start", async (event, ctx) => {
    completionContext.capture(ctx);
    try {
      const defaultResult = await orchestrator.loadDefaultAgent(ctx, event);

      if (defaultResult)
        showCard(pi, defaultResult.text, defaultResult.details);
      else await orchestrator.applyCurrentPolicy(ctx);
    } catch (error) {
      ctx.ui.notify(`pi-gentic: ${getErrorMessage(error)}`, "warning");
    }
  });

  pi.registerShortcut(AGENT_CYCLE_SHORTCUT, {
    description: "Cycle pi-gentic active agent",
    handler: async (ctx) => {
      completionContext.capture(ctx);
      try {
        const result = await orchestrator.cycleAgent(ctx);
        showCard(pi, result.text, result.details);
      } catch (error) {
        showCard(
          pi,
          getErrorMessage(error),
          orchestrator.cardDetails("error", "error", {
            error: getErrorMessage(error),
          }),
        );
      }
    },
  });

  pi.on("agent_start", async (_event, ctx) => {
    orchestrator.setTitle(ctx, true);
  });

  pi.on("agent_end", async (_event, ctx) => {
    orchestrator.setTitle(ctx, false);
  });

  pi.on("before_agent_start", (event, ctx) =>
    orchestrator.buildPromptAppend(ctx, event),
  );

  pi.registerCommand("agent", {
    description: "Set, clear, or show the active pi-gentic agent",
    getArgumentCompletions: (prefix) =>
      completeAgents(prefix, orchestrator.currentAgentName),
    handler: async (args, ctx) => {
      completionContext.capture(ctx);
      const parsed = parseAgentCommand(args);

      if (!parsed.agent) {
        const active = orchestrator.getActiveAgent(ctx);
        ctx.ui.notify(
          active
            ? `Active agent: ${active.name}\n${active.description ?? ""}`
            : "No active agent.",
          "info",
        );
        return;
      }

      try {
        if (parsed.sessionId) {
          const config = loadConfiguration({ cwd: ctx.cwd });
          const runtime = await orchestrator.getOrOpenSession(
            ctx,
            parsed.sessionId,
          );

          if (parsed.agent === "clear") {
            runtime.session.sessionManager.appendCustomEntry(
              "pi-gentic:state",
              { agentName: undefined },
            );
            ctx.ui.notify(
              `Cleared active agent in session ${shortSessionId(runtime.session.sessionManager.getSessionId())}.`,
              "info",
            );
            return;
          }
          await orchestrator.loadAgentIntoSession(
            runtime.session,
            parsed.agent,
            undefined,
            config,
            ctx,
          );
          ctx.ui.notify(
            `Loaded ${parsed.agent} in session ${shortSessionId(runtime.session.sessionManager.getSessionId())}.`,
            "info",
          );
          return;
        }

        const result = await orchestrator.loadAgent(ctx, parsed.agent);
        showCard(pi, result.text, result.details);
      } catch (error) {
        showCard(
          pi,
          getErrorMessage(error),
          orchestrator.cardDetails("error", "error", {
            error: getErrorMessage(error),
          }),
        );
      }
    },
  });

  pi.registerCommand("orchestration-tree", {
    description: "Open the pi-gentic orchestration tree",
    handler: async (_args, ctx) => {
      completionContext.capture(ctx);
      try {
        const result = await orchestrator.discoverSessions(ctx, { all: true });

        if (result.sessions.length === 0) {
          ctx.ui.notify("No sessions found.", "info");
          return;
        }

        const refreshSessions = async () =>
          (await orchestrator.discoverSessions(ctx, { all: true })).sessions;
        const selected = await ctx.ui.custom((tui, theme, _keybindings, done) =>
          createSessionTreePicker(
            result.sessions,
            theme,
            done,
            () => tui.requestRender(),
            { refreshSessions },
          ),
        );
        const currentSelection = selected;
        const sessionPath = currentSelection
          ? treeSwitchPath(currentSelection)
          : undefined;

        if (!sessionPath) return;

        try {
          await ctx.switchSession(sessionPath);
        } catch (error) {
          if (currentSelection?.path && sessionPath !== currentSelection.path)
            await ctx.switchSession(currentSelection.path);
          else throw error;
        }
      } catch (error) {
        ctx.ui.notify(
          `pi-gentic orchestration tree failed: ${getErrorMessage(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("skill", {
    description: "Manually invoke a Pi skill: /skill <name> [request]",
    getArgumentCompletions: (prefix) =>
      completeSkill(prefix, completionContext.current()),
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

      if (!isCompletingSendSession(prefix))
        return completeSend(prefix, snapshot);
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

      if (!parsed.message) {
        ctx.ui.notify(
          "Usage: /send <message> [--agent <agentName>] [--session <sessionId>] [--fork] [--bg|--fg] [--no-invoke] [--cwd <dir>] [--worktree [branch]] [--repo <dir>] [override flags]", 
          "warning",
        );
        return;
      }

      let stopRefresh = (() => {}) as (() => void) & { refresh?: () => void };

      try {
        let showedProgress = false;
        stopRefresh = startLiveRefresh(ctx, "send-command");
        const result = await orchestrator.send(ctx, parsed, {
          awaitCompletion: false,
          onSettled: () => stopRefresh(),
          onRefresh: () => stopRefresh.refresh?.(),
          onUpdate: (update) => {
            if (showedProgress) return;
            showedProgress = true;
            showCard(
              pi,
              firstText(update.content) ?? "Sending message...",
              update.details,
            );
          },
        });

        if (!["running", "queued"].includes(result.details?.status))
          stopRefresh();

        if (!showedProgress) showCard(pi, result.text, result.details);
      } catch (error) {
        stopRefresh();
        showCard(
          pi,
          getErrorMessage(error),
          orchestrator.cardDetails("send", "error", {
            error: getErrorMessage(error),
          }),
        );
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
        const input = normalizeToolInput(params);
        const result = await executeAction(
          orchestrator,
          ctx,
          input,
          onUpdate,
          signal,
        );

        persistSynchronousToolCard(ctx, input, result, persistSessionImmediately);

        return {
          content: [{ type: "text", text: result.text }],
          details: result.details,
        };
      } catch (error) {
        const message = getErrorMessage(error);

        return {
          content: [{ type: "text", text: message }],
          details: orchestrator.cardDetails(
            params?.action ?? "error",
            "error",
            { error: message },
          ),
          isError: true,
        };
      }
    },
  });
}

function createSkillCommandRegistry(
  pi: PiApi,
  _orchestrator: PiGenticOrchestrator,
  completionContext: ReturnType<typeof createCompletionContext>,
) {
  const registered = new Set<string>();

  return {
    sync(ctx: PiContext | undefined, skillNames: string[] = []) {
      const cwd = ctx?.cwd ?? completionContext.current().cwd;

      if (!skillCommandsEnabled(cwd)) return;
      for (const name of skillNames) {
        if (!name || registered.has(name)) continue;
        registered.add(name);
        pi.registerCommand(`skill:${name}`, {
          description: `Manually invoke the ${name} Pi skill`,
          handler: async (args, commandCtx) => {
            completionContext.capture(commandCtx);
            await invokeSkillCommand(pi, name, args, commandCtx);
          },
        });
      }
    },
  };
}

async function invokeSkillCommand(
  pi: PiApi,
  skillName: string,
  message: string,
  ctx: PiContext,
) {
  if (!skillCommandsEnabled(ctx.cwd)) {
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

function skillCommandsEnabled(cwd: string | undefined) {
  return (
    loadPiSettings(undefined, cwd ?? process.cwd()).enableSkillCommands !== false
  );
}

function createCompletionContext(
  pi: PiApi,
  onCapture?: (snapshot: AnyRecord, ctx?: PiContext) => void,
) {
  let snapshot = {
    cwd: process.cwd(),
    sessionDir: undefined as string | undefined,
    currentSessionId: undefined as string | undefined,
    currentSessionPath: undefined as string | undefined,
    agents: [] as AnyRecord[],
    models: [] as AnyRecord[],
    tools: [] as string[],
    skills: [] as string[],
    themes: [] as string[],
    systemPromptFiles: [] as string[],
  };

  return {
    capture(ctx: PiContext | undefined) {
      if (!ctx) return snapshot;
      const cwd = typeof ctx.cwd === "string" ? ctx.cwd : snapshot.cwd;
      const config = loadConfiguration({ cwd });
      snapshot = {
        cwd,
        sessionDir: ctx.sessionManager?.getSessionDir?.() ?? snapshot.sessionDir,
        currentSessionId:
          ctx.sessionManager?.getSessionId?.() ?? snapshot.currentSessionId,
        currentSessionPath:
          ctx.sessionManager?.getSessionFile?.() ?? snapshot.currentSessionPath,
        agents: config.agents,
        models: scopedModelSuggestions(ctx),
        tools: safeToolNames(pi),
        skills: loadAvailableSkills({ cwd }).map((skill) => skill.name),
        themes: themeSuggestions(config),
        systemPromptFiles: systemPromptFileSuggestions(config),
      };
      warmCompletionSessions(snapshot);
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
}) {
  try {
    const persisted = await cachedPersistedSessions(
      completionSessionCacheKey({ cwd, sessionDir }),
      () => listCompletionSessionSources(cwd, sessionDir),
    );
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
    const scoped = sessionCompletionScope(
      buildSessionTree(current, persisted),
      current,
      {
        rx: 4,
        ry: 4,
      },
    );

    return enrichSessionSummaries(scoped, 20);
  } catch {
    return [];
  }
}

function warmCompletionSessions({ cwd, sessionDir }) {
  warmPersistedSessions(completionSessionCacheKey({ cwd, sessionDir }), () =>
    listCompletionSessionSources(cwd, sessionDir),
  );
}

async function listCompletionSessionSources(cwd, sessionDir) {
  const fast = listSessionSummariesFast(sessionDir);

  return fast.length > 0 ? fast : SessionManager.list(cwd, sessionDir);
}

function completionSessionCacheKey({ cwd, sessionDir }) {
  return `${cwd ?? ""}\n${sessionDir ?? ""}`;
}

function scopedModelSuggestions(ctx: PiContext | undefined) {
  const patterns = enabledModelPatterns();
  const registry = ctx?.modelRegistry;
  const available = safeAvailableModels(registry);

  if (patterns.length === 0) return available;

  return patterns.map((pattern) => {
    const [provider, id] = String(pattern).split(/\/(.*)/).filter(Boolean);
    const match = provider && id ? registry?.find?.(provider, id) : undefined;

    return match ?? { provider, id: id ?? pattern, label: pattern };
  });
}

function safeAvailableModels(modelRegistry) {
  try {
    const models = modelRegistry?.getAvailable?.();

    return Array.isArray(models) ? models : [];
  } catch {
    return [];
  }
}

function safeToolNames(pi: PiApi) {
  try {
    return pi.getAllTools().map((tool) => tool.name).filter(Boolean);
  } catch {
    return [];
  }
}

function systemPromptFileSuggestions(config: AnyRecord) {
  const settings = recordValue(config.settings);
  const agentless = recordValue(settings.agentlessSession);
  const defaults = recordValue(settings.agentDefaults);
  const files = [
    ...toStringArray(agentless.systemPromptFiles),
    ...toStringArray(defaults.systemPromptFiles),
    ...config.agents.flatMap((agent) => toStringArray(agent.systemPromptFiles)),
  ];

  return files.filter((file, index) => files.indexOf(file) === index);
}

function recordValue(value: unknown): AnyRecord {
  return value && typeof value === "object" ? (value as AnyRecord) : {};
}

function toStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function themeSuggestions(config: AnyRecord) {
  const themes = [
    config.settings?.theme,
    ...config.agents.map((agent) => agent.theme),
  ].filter((theme): theme is string => typeof theme === "string" && Boolean(theme));

  return themes.filter((theme, index) => themes.indexOf(theme) === index);
}

/** Maps one agents-tool action to one orchestrator operation. */
async function executeAction(orchestrator, ctx, input, onUpdate, signal) {
  if (input.action === "list") {
    const config = loadConfiguration({ cwd: ctx.cwd });
    const agents = orchestrator.availableAgents(ctx, config);
    const text =
      agents
        .map((agent) => `${agent.name}: ${agent.description ?? ""}`)
        .join("\n") || "No agents configured.";

    return {
      text,
      details: orchestrator.cardDetails("list", "done", {
        configuration: { agents: agents.map((agent) => agent.name) },
      }),
    };
  }

  if (input.action === "get") {
    if (!input.agent) throw new Error('Field "agent" is required for get.');
    const config = loadConfiguration({ cwd: ctx.cwd });
    const agent = orchestrator
      .availableAgents(ctx, config)
      .find((item) => item.name === input.agent);

    if (!agent)
      throw new Error(`Unknown or unavailable agent "${input.agent}".`);
    return {
      text: JSON.stringify(agent, null, 2),
      details: orchestrator.cardDetails("get", "done", {
        agentName: agent.name,
        configuration: agent,
      }),
    };
  }

  if (input.action === "status") {
    if (!input.sessionId)
      throw new Error('Field "sessionId" is required for status.');
    const status = await orchestrator.status(ctx, input.sessionId);

    return {
      text: status.text,
      details: orchestrator.cardDetails("status", "done", {
        sessionId: status.sessionId,
        configuration: status,
      }),
    };
  }

  if (input.action === "load") {
    return orchestrator.loadAgent(ctx, input.agent, {
      overrides: input.overrides,
    });
  }

  if (input.action === "send") {
    if (typeof input.message !== "string" || !input.message.trim())
      throw new Error('Field "message" is required for send.');
    const stopRefresh = startLiveRefresh(ctx, "agents-tool");
    try {
      const result = await orchestrator.send(ctx, input, {
        onUpdate,
        signal,
        onRefresh: () => stopRefresh.refresh?.(),
        onSettled: () => stopRefresh(),
      });

      if (!["running", "queued"].includes(result.details?.status)) stopRefresh();

      return result;
    } catch (error) {
      stopRefresh();
      throw error;
    }
  }

  if (input.action === "abort") {
    const text = await orchestrator.abort(ctx, input.sessionId);

    return {
      text,
      details: orchestrator.cardDetails("abort", "done", {
        sessionId: input.sessionId,
      }),
    };
  }

  if (input.action === "discoverSessions") {
    const result = await orchestrator.discoverSessions(ctx, input);

    return {
      text: JSON.stringify(result, null, 2),
      details: orchestrator.cardDetails("discoverSessions", "done", {
        configuration: result,
        sessions: result.sessions,
      }),
    };
  }

  throw new Error(`Unknown action "${input.action}".`);
}

function firstText(content) {
  return Array.isArray(content)
    ? content.find((item) => item.type === "text")?.text
    : undefined;
}
