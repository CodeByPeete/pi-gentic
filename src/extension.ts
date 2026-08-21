import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorMessage as getErrorMessage } from "./shared/values.js";
import { reportRuntimeDiagnostic } from "./shared/diagnostics.js";
import { installPiHost } from "./pi/host.js";
import { clearActiveVisibleExtension, setActiveVisibleExtension } from "./pi/sessions.js";
import { createOrchestrator } from "./delegation/send.js";
import type { PiContext } from "./pi/types.js";
import type { UnknownRecord } from "./shared/values.js";
import { createExtensionRuntime, shouldDisposeExtensionRuntime } from "./extension-runtime.js";
import { installResumeIntegration } from "./pi/resume/selector.js";
import { installAgentsTool } from "./agents/tool.js";
import { setAgentLabel, showCard, startSessionLiveCardRefresh } from "./ui/cards.js";
import { renderAgentsResult } from "./ui/card-renderer.js";
import { restorePersistedCardDetails } from "./ui/cards.js";
import { createCompletionContext } from "./ui/completions.js";
import { installTerminalCommands } from "./ui/commands.js";
import { reportDiagnostics } from "./ui/terminal.js";

export default async function piGentic(pi: ExtensionAPI) {
  const runtime = createExtensionRuntime();

  await installPiHost();
  await installResumeIntegration(runtime);
  const orchestrator = createOrchestrator(pi, runtime, setAgentLabel);
  const completionContext = createCompletionContext(pi, {
    resolveSkills: (ctx) => orchestrator.applyPolicySnapshot(ctx).policy.resources.skills,
  });
  const delegationContextBoundaries = new WeakMap<PiContext["sessionManager"], string | null>();
  let runtimeDisposed = false;
  let stopSessionLiveCardRefresh: (() => void) | undefined;
  const synchronizeAgentsTool = installAgentsTool({
    pi,
    runtime,
    orchestrator,
    captureContext: completionContext.capture,
    delegationBoundaries: delegationContextBoundaries,
  });
  installTerminalCommands(pi, orchestrator, completionContext, (text, details) => showCard(pi, text, details));

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
    reportDiagnostics(pi, ctx);
    try {
      const defaultResult = await orchestrator.loadDefaultAgent(ctx, event);

      if (defaultResult) showCard(pi, defaultResult.text, defaultResult.details);
      else await orchestrator.applyCurrentPolicy(ctx);
      await synchronizeAgentsTool(ctx);
      completionContext.capture(ctx);
    } catch (error) {
      ctx.ui.notify(`pi-gentic: ${getErrorMessage(error)}`, "warning");
    }
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

  pi.on("before_agent_start", async (event, ctx) => {
    await synchronizeAgentsTool(ctx);
    const forkBoundaryEntryId = ctx.sessionManager.getLeafId?.();

    if (forkBoundaryEntryId !== undefined) delegationContextBoundaries.set(ctx.sessionManager, forkBoundaryEntryId);
    else delegationContextBoundaries.delete(ctx.sessionManager);

    return orchestrator.buildPromptAppend(ctx, event);
  });
}
