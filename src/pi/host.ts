import { getActiveState } from "../agents/activation.js";
import {
  drainTransitionSubmissions,
  installInteractiveInput,
  installSessionLifecycle,
  markSessionTransitionReady,
  trackSessionTransition,
} from "./input.js";
import { getRuntimeSession, liveSessionId, runtimeSessionIsRunning, setRuntimeSession } from "./sessions.js";
import {
  assertPiHostCapabilities,
  callHostMethod,
  captureHostMethod,
  getLiveRuntimeState,
  loadPiCodingAgentPeer,
  recordHostDiagnostic,
  type LiveRuntimeState,
  type PiCodingAgentPeer,
} from "./runtime.js";
import type { HostRecord, PiAgentRuntimeHost, PiContext, SessionTransition } from "./types.js";

/** Installs the integration for the currently installed Pi host after validating its required capabilities. */
export async function installPiHost() {
  const state = getLiveRuntimeState();
  state.hostDiagnostics.length = 0;

  try {
    const peer = await loadPiCodingAgentPeer();
    assertPiHostCapabilities(peer);
    for (const diagnostic of peer.diagnostics ?? [])
      if (!state.hostDiagnostics.includes(diagnostic)) state.hostDiagnostics.push(diagnostic);
    installSessionReplacements(state, peer);
    installSessionLifecycle(state, peer);
    installInteractiveInput(state, peer);
  } catch (error) {
    recordHostDiagnostic(error);
  }
}

export function piHostDiagnostics() {
  return [...getLiveRuntimeState().hostDiagnostics];
}

const noop = () => {};
const noopAsync = async () => {};

function installSessionReplacements(state: LiveRuntimeState, peer: PiCodingAgentPeer) {
  installRuntimeSwitch(state, peer);
  installRuntimeTransitions(state, peer);
}

function installRuntimeSwitch(
  state: LiveRuntimeState,
  { AgentSessionRuntime }: Pick<PiCodingAgentPeer, "AgentSessionRuntime">,
) {
  if (!captureHostMethod(state, "runtime.switchSession", AgentSessionRuntime.prototype.switchSession)) return;
  AgentSessionRuntime.prototype.switchSession = async function switchSessionWithLiveRuntime(
    sessionPath: string,
    options?: HostRecord,
  ) {
    return trackSessionTransition(state, this, "selected session", async (transition) => {
      const switchOptions = withVisibleContextTracking(state, this, transition, options);
      const sessionId = liveSessionId(sessionPath);

      if (!sessionId) return switchPersistedSession(state, this, sessionPath, switchOptions);
      const live = state.liveRuntimes.get(sessionId) as
        | { runtime: PiAgentRuntimeHost; metadata?: HostRecord }
        | undefined;

      if (!live) {
        const persistedPath = state.runtimeSessions.get(sessionId)?.session.sessionManager.getSessionFile?.();

        if (typeof persistedPath === "string" && persistedPath)
          return switchPersistedSession(state, this, persistedPath, switchOptions);
        throw new Error(`No live pi-gentic session ${sessionId} is available.`);
      }
      const targetSessionFile = live.runtime.session.sessionFile;
      const beforeResult = await this.emitBeforeSwitch("resume", targetSessionFile);

      if (beforeResult.cancelled) return beforeResult;
      const restore = parkCurrentLiveRuntimeForSwitch(state, this);

      try {
        await this.teardownCurrent("resume", targetSessionFile);
      } finally {
        restore();
      }
      this.apply({
        session: live.runtime.session,
        services: live.runtime.services,
        diagnostics: live.runtime.diagnostics,
        modelFallbackMessage: live.runtime.modelFallbackMessage,
      });
      await this.finishSessionReplacement(switchOptions.withSession);

      return { cancelled: false };
    });
  };
}

async function switchPersistedSession(
  state: LiveRuntimeState,
  runtimeHost: HostRecord,
  sessionPath: string,
  options: HostRecord,
) {
  const restore = parkCurrentLiveRuntimeForSwitch(state, runtimeHost);

  try {
    return await callHostMethod(state, "runtime.switchSession", runtimeHost, [sessionPath, options]);
  } finally {
    restore();
  }
}

function installRuntimeTransitions(
  state: LiveRuntimeState,
  { AgentSessionRuntime }: Pick<PiCodingAgentPeer, "AgentSessionRuntime">,
) {
  const transitions = [
    { method: "newSession", destination: "new session", optionsIndex: 0 },
    { method: "fork", destination: "forked session", optionsIndex: 1 },
    { method: "importFromJsonl", destination: "imported session", optionsIndex: undefined },
  ] as const;

  for (const { method, destination, optionsIndex } of transitions) {
    const key = `runtime.${method}`;
    if (!captureHostMethod(state, key, AgentSessionRuntime.prototype[method])) continue;
    AgentSessionRuntime.prototype[method] = async function transitionWithLiveRuntime(...args: unknown[]) {
      return trackSessionTransition(state, this, destination, async (transition) => {
        const restore = parkCurrentLiveRuntimeForSwitch(state, this);
        if (optionsIndex !== undefined)
          args[optionsIndex] = withVisibleContextTracking(state, this, transition, args[optionsIndex] as HostRecord);
        try {
          return await callHostMethod(state, key, this, args);
        } finally {
          restore();
        }
      });
    };
  }
}

function withVisibleContextTracking(
  state: LiveRuntimeState,
  runtimeHost: HostRecord,
  transition: SessionTransition,
  options: HostRecord = {},
) {
  const originalWithSession = options.withSession;

  return {
    ...options,
    async withSession(nextCtx: PiContext) {
      state.activeContext = nextCtx;
      state.activeSession = runtimeHost.session;
      markSessionTransitionReady(state, runtimeHost, transition);
      const originalWork = Promise.resolve().then(() =>
        typeof originalWithSession === "function" ? originalWithSession(nextCtx) : undefined,
      );
      await Promise.all([originalWork, drainTransitionSubmissions(state, transition)]);
    },
  };
}

function parkMethod(target: HostRecord, method: string, replacement: (...args: unknown[]) => unknown) {
  const original = target[method];

  if (typeof original !== "function") return noop;
  target[method] = replacement;

  return () => {
    if (target[method] === replacement) target[method] = original;
  };
}

export function parkCurrentLiveRuntimeForSwitch(state: LiveRuntimeState, runtimeHost: HostRecord | undefined) {
  const session = runtimeHost?.session;

  if (!session) return noop;
  const parkAbort = () => parkMethod(session, "abort", noopAsync);
  const sessionId = session.sessionManager?.getSessionId?.();
  const tracked = sessionId ? getRuntimeSession(sessionId) : undefined;
  const liveRuntime = tracked?.runtimeHost ?? snapshotRuntimeHost(runtimeHost, session);

  if (
    !sessionId ||
    (session.isStreaming !== true && !runtimeSessionIsRunning(tracked)) ||
    !liveRuntime ||
    liveRuntime.session !== session
  )
    return parkAbort();
  const runtime = setRuntimeSession(sessionId, {
    ...tracked,
    runtimeHost: liveRuntime,
    session,
    agentName: tracked?.agentName ?? getActiveState(session.sessionManager).agentName,
    parentSessionPath: tracked?.parentSessionPath ?? session.sessionManager.getHeader?.()?.parentSession,
  });

  state.liveRuntimes.set(sessionId, {
    runtime: liveRuntime,
    metadata: { agentName: runtime.agentName },
  });

  if (typeof runtimeHost.teardownCurrent === "function") return parkMethod(runtimeHost, "teardownCurrent", noopAsync);
  if (typeof session.dispose !== "function") return noop;
  const restoreAbort = parkAbort();
  const restoreDispose = parkMethod(session, "dispose", noop);

  return () => {
    restoreAbort();
    restoreDispose();
  };
}

function snapshotRuntimeHost(runtimeHost: HostRecord | undefined, session: HostRecord) {
  if (!runtimeHost) return undefined;

  return {
    session,
    services: runtimeHost.services,
    diagnostics: runtimeHost.diagnostics,
    modelFallbackMessage: runtimeHost.modelFallbackMessage,
  } as PiAgentRuntimeHost;
}
