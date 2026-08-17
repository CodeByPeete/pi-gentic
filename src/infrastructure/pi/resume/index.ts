import { reportRuntimeDiagnostic } from "../../../shared/diagnostics.js";
import type { ExtensionRuntime } from "../../../runtime/ExtensionRuntime.js";
import { loadPiCodingAgentPeer } from "../peer.js";
import { recordHostDiagnostic, type HostRecord } from "../state.js";
import { installSessionListCache, visibleSessionMembership } from "./cache.js";
import { openDecoratedResumeSelector, publishResumeSessionMetadata } from "./selector.js";

export { loadSessionListIsolated, visibleSessionMembership } from "./cache.js";
export { decorateResumeSelector } from "./selector.js";

const RESUME_INTEGRATION_KEY = Symbol.for("pi-gentic.resume-integration");

type ResumeIntegrationState = {
  installed: boolean;
  runtime: ExtensionRuntime;
  originalShowSessionSelector?: (this: HostRecord, ...args: unknown[]) => unknown;
};

/** Enhances Pi's native resume selector while preserving its loading and navigation behavior. */
export async function installResumeIntegration(runtime: ExtensionRuntime) {
  const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
  const integration = (globalState[RESUME_INTEGRATION_KEY] ??= {
    installed: false,
    runtime,
  }) as ResumeIntegrationState;
  integration.runtime = runtime;

  if (integration.installed) return;

  try {
    const peer = await loadPiCodingAgentPeer();
    const prototype = peer.InteractiveMode?.prototype;
    const nativeShowSessionSelector = prototype?.showSessionSelector;
    const theme = peer.theme;
    const SessionManager = peer.SessionManager;

    if (typeof nativeShowSessionSelector !== "function" || !prototype)
      throw new Error("Pi resume integration unavailable: InteractiveMode.showSessionSelector is missing.");
    if (!theme) throw new Error("Pi resume integration unavailable: active theme is inaccessible.");
    if (!SessionManager) throw new Error("Pi resume integration unavailable: SessionManager is inaccessible.");

    await installSessionListCache(SessionManager, integration.runtime, publishResumeSessionMetadata);
    integration.installed = true;
    integration.originalShowSessionSelector = nativeShowSessionSelector;
    prototype.showSessionSelector = function showSessionSelectorWithPiGentic(this: HostRecord, ...args: unknown[]) {
      const selector = integration.originalShowSessionSelector;

      if (typeof selector !== "function")
        throw new Error("Pi resume integration unavailable: native session selector was lost.");
      return openDecoratedResumeSelector(
        this,
        selector,
        args,
        theme,
        integration.runtime,
        visibleSessionMembership(this),
      );
    };
  } catch (error) {
    recordHostDiagnostic(error);
    reportRuntimeDiagnostic("pi-host-resume-install", error);
  }
}
