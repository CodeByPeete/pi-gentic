import { installInteractiveInput, installSessionLifecycle } from "./input.js";
import { assertPiHostCapabilities, loadPiCodingAgentPeer } from "./peer.js";
import { installSessionReplacements } from "./sessions/replacements.js";
import { getLiveRuntimeState } from "./state.js";

export {
  abortAgentCall,
  abortAgentCallsForSession,
  assertNoAgentCallCycle,
  hasAgentCallsForSession,
  registerAgentCall,
} from "./delegation.js";
export { handleInteractiveEscape, shouldPromptVisibleSessionNow, trackSessionPrompt } from "./input.js";
export {
  applyInheritedModel,
  createLiveRuntime,
  deleteRuntimeSession,
  findRuntimeSession,
  getRuntimeSession,
  inheritedModelForPolicy,
  isSessionActivityEvent,
  listRuntimeSessions,
  livePath,
  persistSessionImmediately,
  pruneRuntimeSessions,
  registerLiveRuntime,
  resolveModelFromCatalog,
  runtimeSessionIsRunning,
  setRuntimeSession,
  unregisterLiveRuntime,
} from "./sessions/live.js";
export { assertPiHostCapabilities, loadPiCodingAgentPeer } from "./peer.js";
export {
  activeVisibleContext,
  activeVisibleExtension,
  activeVisibleSession,
  clearActiveVisibleExtension,
  parkCurrentLiveRuntimeForSwitch,
  setActiveVisibleExtension,
} from "./sessions/replacements.js";
export { getLiveRuntimeState } from "./state.js";

/** Installs the integration for the currently installed Pi host after validating its required capabilities. */
export async function installPiHost() {
  const state = getLiveRuntimeState();

  state.hostDiagnostics.length = 0;

  try {
    const peer = await loadPiCodingAgentPeer();

    assertPiHostCapabilities(peer);
    for (const diagnostic of peer.diagnostics ?? []) {
      if (!state.hostDiagnostics.includes(diagnostic)) state.hostDiagnostics.push(diagnostic);
    }
    installSessionReplacements(state, peer);
    installSessionLifecycle(state, peer);
    installInteractiveInput(state, peer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!state.hostDiagnostics.includes(message)) state.hostDiagnostics.push(message);
  }
}

export function piHostDiagnostics() {
  return [...getLiveRuntimeState().hostDiagnostics];
}
