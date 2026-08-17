import { Tool } from "effect/unstable/ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_CYCLE_SHORTCUT } from "./application/agents/state.js";
import { loadPiSettings } from "./infrastructure/configuration/agents.js";
import { findAvailableSkill } from "./infrastructure/configuration/skills.js";
import { errorMessage as getErrorMessage, firstText, isRecord, shortSessionId } from "./shared/value.js";
import {
  buildManualSkillMessage,
  parseAgentCommand,
  parseSendCommand,
  parseSkillCommand,
} from "./interface/commands.js";
import { completeAgents, completeSend, completeSkill, isCompletingSendSession } from "./interface/completions.js";
import { reportRuntimeDiagnostic } from "./shared/diagnostics.js";
import { AgentsToolParametersSchema, normalizeAgentsToolInput } from "./domain/agents-tool.js";
import { clearActiveVisibleExtension, installPiHost, setActiveVisibleExtension } from "./infrastructure/pi/host.js";
import { PiGenticOrchestrator } from "./application/delegation/orchestrator.js";
import type { PiApi, PiContext } from "./infrastructure/pi/types.js";
import type { UnknownRecord } from "./shared/types.js";
import { createExtensionRuntime, shouldDisposeExtensionRuntime } from "./runtime/ExtensionRuntime.js";
import { installResumeIntegration } from "./infrastructure/pi/resume/index.js";
import { executeAction } from "./interface/agents-tool-handler.js";
import { showCard, startSessionLiveCardRefresh } from "./interface/cards/live.js";
import { renderAgentsCall, renderAgentsResult } from "./interface/cards/render.js";
import { restorePersistedCardDetails } from "./interface/cards/state.js";
import { createCompletionContext, listCompletionSessions } from "./interface/completion-context.js";
import { reportDiagnostics } from "./interface/startup-diagnostics.js";

const AgentsToolParameters = Tool.getJsonSchemaFromSchema(AgentsToolParametersSchema);

function showErrorCard(pi: PiApi, orchestrator: PiGenticOrchestrator, error: unknown, kind = "error") {
  const message = getErrorMessage(error);

  showCard(pi, message, orchestrator.cardDetails(kind, "error", { error: message }));
}

export default async function piGentic(pi: ExtensionAPI) {
  const runtime = createExtensionRuntime();

  await installPiHost();
  await installResumeIntegration(runtime);
  const orchestrator = new PiGenticOrchestrator(pi, runtime);
  const completionContext = createCompletionContext(pi);
  const delegationContextBoundaries = new WeakMap<PiContext["sessionManager"], string | null>();
  let runtimeDisposed = false;
  let stopSessionLiveCardRefresh: (() => void) | undefined;

  pi.on("session_shutdown", async (event) => {
    stopSessionLiveCardRefresh?.();
    stopSessionLiveCardRefresh = undefined;
    clearActiveVisibleExtension(pi);
    if (runtimeDisposed || !shouldDisposeExtensionRuntime(event.reason)) return;
    runtimeDisposed = true;

    if (event.reason === "reload")
      void runtime.disposeWhenIdle().catch((error) => reportRuntimeDiagnostic("extension-runtime-disposal", error));
    else await runtime.dispose();
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

  pi.on("before_agent_start", (event, ctx) => {
    const forkBoundaryEntryId = ctx.sessionManager.getLeafId?.();

    if (forkBoundaryEntryId !== undefined) delegationContextBoundaries.set(ctx.sessionManager, forkBoundaryEntryId);
    else delegationContextBoundaries.delete(ctx.sessionManager);

    return orchestrator.buildPromptAppend(ctx, event);
  });

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
          const config = orchestrator.load(ctx);
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
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      completionContext.capture(ctx);
      try {
        const input = await runtime.runPromise(normalizeAgentsToolInput(params));
        const callerEntryId = ctx.sessionManager.getLeafId?.();
        const forkBoundaryEntryId =
          input.action === "send" ? delegationContextBoundaries.get(ctx.sessionManager) : undefined;
        const call = {
          toolCallId,
          ...(callerEntryId ? { callerEntryId } : {}),
          ...(forkBoundaryEntryId !== undefined ? { forkBoundaryEntryId } : {}),
          parameters: params,
        };
        const result = await executeAction(orchestrator, ctx, input, onUpdate, signal, call);

        return {
          content: [
            {
              type: "text",
              text: typeof result.text === "string" ? result.text : String(result.text ?? ""),
            },
          ],
          details: { ...result.details, call },
        };
      } catch (error) {
        throw new Error(getErrorMessage(error), { cause: error });
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
