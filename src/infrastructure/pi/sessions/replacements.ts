import { getActiveState } from "../../../application/agents/state.js";
import type { PiAgentRuntimeHost, PiApi, PiContext } from "../types.js";
import {
  drainTransitionSubmissions,
  markSessionTransitionReady,
  trackSessionTransition,
  type SessionTransition,
} from "./transitions.js";
import { getRuntimeSession, liveSessionId, runtimeSessionIsRunning, setRuntimeSession } from "./live.js";
import type { PiCodingAgentPeer } from "../peer.js";
import { getLiveRuntimeState, type HostRecord, type LiveRuntimeState } from "../state.js";

const noop = () => {};
const noopAsync = async () => {};

export function installSessionReplacements(state: LiveRuntimeState, peer: PiCodingAgentPeer) {
  installRuntimeSwitch(state, peer);
  installRuntimeNewSession(state, peer);
  installRuntimeFork(state, peer);
  installRuntimeImport(state, peer);
}

function installRuntimeSwitch(
  state: LiveRuntimeState,
  { AgentSessionRuntime }: Pick<PiCodingAgentPeer, "AgentSessionRuntime">,
) {
  if (state.switchSessionInstalled) return;
  state.switchSessionInstalled = true;
  state.hostSwitchSession = AgentSessionRuntime.prototype.switchSession as LiveRuntimeState["hostSwitchSession"];
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
    return await state.hostSwitchSession?.call(runtimeHost, sessionPath, options);
  } finally {
    restore();
  }
}

function installRuntimeNewSession(
  state: LiveRuntimeState,
  { AgentSessionRuntime }: Pick<PiCodingAgentPeer, "AgentSessionRuntime">,
) {
  if (state.newSessionInstalled) return;
  state.newSessionInstalled = true;
  state.hostNewSession = AgentSessionRuntime.prototype.newSession as LiveRuntimeState["hostNewSession"];
  AgentSessionRuntime.prototype.newSession = async function newSessionWithLiveRuntime(options?: HostRecord) {
    return trackSessionTransition(state, this, "new session", async (transition) => {
      const restore = parkCurrentLiveRuntimeForSwitch(state, this);

      try {
        return await state.hostNewSession?.call(this, withVisibleContextTracking(state, this, transition, options));
      } finally {
        restore();
      }
    });
  };
}

function installRuntimeFork(
  state: LiveRuntimeState,
  { AgentSessionRuntime }: Pick<PiCodingAgentPeer, "AgentSessionRuntime">,
) {
  if (state.forkSessionInstalled) return;
  state.forkSessionInstalled = true;
  state.hostForkSession = AgentSessionRuntime.prototype.fork as LiveRuntimeState["hostForkSession"];
  AgentSessionRuntime.prototype.fork = async function forkWithLiveRuntime(entryId: string, options?: HostRecord) {
    return trackSessionTransition(state, this, "forked session", async (transition) => {
      const restore = parkCurrentLiveRuntimeForSwitch(state, this);

      try {
        return await state.hostForkSession?.call(
          this,
          entryId,
          withVisibleContextTracking(state, this, transition, options),
        );
      } finally {
        restore();
      }
    });
  };
}

function installRuntimeImport(
  state: LiveRuntimeState,
  { AgentSessionRuntime }: Pick<PiCodingAgentPeer, "AgentSessionRuntime">,
) {
  if (state.importSessionInstalled) return;
  state.importSessionInstalled = true;
  state.hostImportSession = AgentSessionRuntime.prototype.importFromJsonl as LiveRuntimeState["hostImportSession"];
  AgentSessionRuntime.prototype.importFromJsonl = async function importWithLiveRuntime(
    inputPath: string,
    cwdOverride?: string,
  ) {
    return trackSessionTransition(state, this, "imported session", async () => {
      const restore = parkCurrentLiveRuntimeForSwitch(state, this);

      try {
        return await state.hostImportSession?.call(this, inputPath, cwdOverride);
      } finally {
        restore();
      }
    });
  };
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
      let originalWork: Promise<unknown>;

      try {
        originalWork =
          typeof originalWithSession === "function" ? Promise.resolve(originalWithSession(nextCtx)) : Promise.resolve();
      } catch (error) {
        originalWork = Promise.reject(error);
      }
      await Promise.all([originalWork, drainTransitionSubmissions(state, transition)]);
    },
  };
}

export function setActiveVisibleExtension(api: PiApi, ctx: PiContext) {
  const state = getLiveRuntimeState();

  state.activeApi = api;
  state.activeContext = ctx;
}

export function clearActiveVisibleExtension(api: PiApi) {
  const state = getLiveRuntimeState();

  if (state.activeApi !== api) return false;
  state.activeApi = undefined;
  state.activeContext = undefined;
  state.activeSession = undefined;

  return true;
}

export function activeVisibleExtension() {
  return getLiveRuntimeState().activeApi;
}

export function activeVisibleContext() {
  return getLiveRuntimeState().activeContext;
}

export function activeVisibleSession() {
  return getLiveRuntimeState().activeSession;
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
