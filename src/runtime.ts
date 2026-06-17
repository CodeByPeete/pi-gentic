/**
 * Runtime integration with Pi.
 *
 * This module owns live session hosts, background runtime lookup, recursive
 * abort wiring, and the prototype bridges needed to resume live sessions.
 */
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultAgentDir } from "./config.js";

type LiveRuntimeState = {
  liveRuntimes: Map<string, AnyRecord>;
  hostSwitchSession?: (this: unknown, sessionPath: string, options?: AnyRecord) => Promise<unknown>;
  hostAbortSession?: (this: unknown, ...args: unknown[]) => Promise<unknown>;
  hostSetupKeyHandlers?: (this: unknown, ...args: unknown[]) => unknown;
  activeContext?: PiContext;
  activeSession?: PiAgentSession;
  bridgeInstalled: boolean;
  abortBridgeInstalled: boolean;
  escapeBridgeInstalled: boolean;
};

type PiCodingAgentPeer = {
  AgentSession: { prototype: AnyRecord };
  AgentSessionRuntime: { prototype: AnyRecord };
  InteractiveMode?: { prototype?: AnyRecord };
  createAgentSessionFromServices: (options: AnyRecord) => Promise<{
    session: PiAgentSession;
    modelFallbackMessage?: string;
  }>;
  createAgentSessionRuntime: (
    createRuntime: (options: AnyRecord) => Promise<AnyRecord>,
    options: AnyRecord,
  ) => Promise<PiAgentRuntimeHost>;
  createAgentSessionServices: (options: AnyRecord) => Promise<AnyRecord>;
};

let peerModule: Promise<PiCodingAgentPeer> | undefined;

/** Resolves Pi peer APIs from tests, local installs, or Pi managed installs. */
async function piCodingAgent(): Promise<PiCodingAgentPeer> {
  const managedCli = path.join(
    homedir(),
    "AppData",
    "Local",
    "pi-managed",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
  const indexFiles = [process.env.PI_CLI, process.argv[1], managedCli]
    .filter(Boolean)
    .map((file) => path.join(path.dirname(String(file)), "index.js"));

  peerModule ??= importFirst([
    "@earendil-works/pi-coding-agent",
    ...indexFiles.map((file) => pathToFileURL(file).href),
  ]);

  return peerModule;
}

async function importFirst(specifiers: string[]): Promise<PiCodingAgentPeer> {
  for (const specifier of specifiers) {
    try {
      return (await import(specifier)) as unknown as PiCodingAgentPeer;
    } catch {}
  }

  return (await import("@earendil-works/pi-coding-agent")) as unknown as PiCodingAgentPeer;
}

const LIVE_RUNTIME_STATE_KEY = Symbol.for("pi-gentic.live-runtime-state");

export function getLiveRuntimeState(): LiveRuntimeState {
  return (globalThis[LIVE_RUNTIME_STATE_KEY] ??= {
    liveRuntimes: new Map(),
    hostSwitchSession: undefined,
    hostAbortSession: undefined,
    hostSetupKeyHandlers: undefined,
    activeContext: undefined,
    activeSession: undefined,
    bridgeInstalled: false,
    abortBridgeInstalled: false,
    escapeBridgeInstalled: false,
  });
}

type AgentCall = {
  id: string;
  callerSessionId?: string;
  targetSessionId?: string;
  abort?: (options?: AnyRecord) => Promise<void> | void;
  startedAt?: number;
};

type AbortState = {
  sessions: Set<unknown>;
  calls: Set<unknown>;
};

const activeCalls = new Map<string, AgentCall>();

let nextCallId = 0;

export function registerAgentCall(call: Omit<AgentCall, "id" | "startedAt"> & { id?: string }) {
  const id = call.id ?? `agent-call:${++nextCallId}`;

  activeCalls.set(id, { ...call, id, startedAt: Date.now() });

  return {
    id,
    unregister: () => activeCalls.delete(id),
  };
}

export function hasAgentCallsForSession(sessionId) {
  return activeCallsForSession(sessionId).length > 0;
}

export async function abortAgentCall(callId, options = {}) {
  return abortCalls([activeCalls.get(callId)].filter(Boolean), options);
}

export async function abortAgentCallsForSession(sessionId, options = {}) {
  return abortCalls(activeCallsForSession(sessionId), options);
}

function activeCallsForSession(sessionId) {
  return [...activeCalls.values()].filter(
    (call) => call.callerSessionId === sessionId,
  );
}

async function abortCalls(calls: AgentCall[], options: AnyRecord = {}) {
  const state = isAbortState(options.state)
    ? options.state
    : { sessions: new Set(), calls: new Set() };
  let aborted = 0;

  for (const call of calls) {
    if (!call || state.calls.has(call.id)) continue;
    state.calls.add(call.id);

    if (call.targetSessionId && !state.sessions.has(call.targetSessionId)) {
      state.sessions.add(call.targetSessionId);
      aborted += await abortAgentCallsForSession(call.targetSessionId, {
        ...options,
        state,
      });
    }

    if (typeof call.abort === "function") {
      await call.abort(options);
      aborted += 1;
    }
  }

  return aborted;
}

function isAbortState(value: unknown): value is AbortState {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { sessions?: unknown }).sessions instanceof Set &&
    (value as { calls?: unknown }).calls instanceof Set
  );
}

export const LIVE_SESSION_PREFIX = "pi-gentic-live:";

/** Installs bridge hooks once so live background sessions can be resumed in Pi. */
export function installLiveSessionBridge() {
  const state = getLiveRuntimeState();

  void piCodingAgent().then((peer) => {
    installRuntimeSwitchBridge(state, peer);
    installSessionAbortBridge(state, peer);
    installInteractiveEscapeBridge(state, peer);
  });
}

function installRuntimeSwitchBridge(
  state: LiveRuntimeState,
  { AgentSessionRuntime }: Pick<PiCodingAgentPeer, "AgentSessionRuntime">,
) {
  if (state.bridgeInstalled) return;
  state.bridgeInstalled = true;
  state.hostSwitchSession = AgentSessionRuntime.prototype.switchSession as LiveRuntimeState["hostSwitchSession"];
  AgentSessionRuntime.prototype.switchSession =
    async function switchSessionWithLiveRuntime(sessionPath, options) {
      const switchOptions = withVisibleContextTracking(state, this, options);

      if (
        typeof sessionPath !== "string" ||
        !sessionPath.startsWith(LIVE_SESSION_PREFIX)
      ) {
        const restore = parkCurrentLiveRuntimeForSwitch(state, this);

        try {
          return await state.hostSwitchSession?.call(
            this,
            sessionPath,
            switchOptions,
          );
        } finally {
          restore();
        }
      }

      const sessionId = sessionPath.slice(LIVE_SESSION_PREFIX.length);
      const live = state.liveRuntimes.get(sessionId) as
        | { runtime: PiAgentRuntimeHost; metadata?: AnyRecord }
        | undefined;

      if (!live)
        throw new Error(`No live pi-gentic session ${sessionId} is available.`);
      const targetSessionFile = live.runtime.session.sessionFile;
      const beforeResult = await this.emitBeforeSwitch(
        "resume",
        targetSessionFile,
      );

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
    };
}

function withVisibleContextTracking(
  state: LiveRuntimeState,
  runtimeHost: PiAgentRuntimeHost,
  options: AnyRecord = {},
) {
  const originalWithSession = options.withSession;

  return {
    ...options,
    async withSession(nextCtx: PiContext) {
      state.activeContext = nextCtx;
      state.activeSession = runtimeHost.session;

      if (typeof originalWithSession === "function")
        await originalWithSession(nextCtx);
    },
  };
}

export function activeVisibleContext() {
  return getLiveRuntimeState().activeContext;
}

export function activeVisibleSession() {
  return getLiveRuntimeState().activeSession;
}

export function parkCurrentLiveRuntimeForSwitch(
  state: LiveRuntimeState,
  runtimeHost: PiAgentRuntimeHost | undefined,
) {
  const session = runtimeHost?.session;
  const sessionId = session?.sessionManager?.getSessionId?.();
  const tracked = sessionId ? getRuntimeSession(sessionId) : undefined;
  const liveRuntime = tracked?.runtimeHost;

  if (
    !sessionId ||
    session?.isStreaming !== true ||
    !liveRuntime ||
    liveRuntime.session !== session ||
    typeof session.dispose !== "function"
  )
    return () => {};
  const originalDispose = session.dispose;
  const parkedDispose = () => {};

  state.liveRuntimes.set(sessionId, {
    runtime: liveRuntime,
    metadata: { agentName: tracked.agentName },
  });
  session.dispose = parkedDispose;

  return () => {
    if (session.dispose !== parkedDispose) return;
    session.dispose = originalDispose;
  };
}

function installSessionAbortBridge(
  state: LiveRuntimeState,
  { AgentSession }: Pick<PiCodingAgentPeer, "AgentSession">,
) {
  if (state.abortBridgeInstalled) return;
  state.abortBridgeInstalled = true;
  state.hostAbortSession =
    AgentSession.prototype.abort as LiveRuntimeState["hostAbortSession"];

  AgentSession.prototype.abort = async function abortWithPiGenticTargets(
    ...args
  ) {
    await abortAgentCallsForSession(this.sessionManager.getSessionId?.(), {
      actor: "aborted session",
    });

    return state.hostAbortSession?.apply(this, args);
  };
}

function installInteractiveEscapeBridge(
  state: LiveRuntimeState,
  { InteractiveMode }: Pick<PiCodingAgentPeer, "InteractiveMode">,
) {
  if (
    state.escapeBridgeInstalled ||
    !InteractiveMode?.prototype?.setupKeyHandlers
  )
    return;
  state.escapeBridgeInstalled = true;
  state.hostSetupKeyHandlers = InteractiveMode.prototype.setupKeyHandlers as LiveRuntimeState["hostSetupKeyHandlers"];
  InteractiveMode.prototype.setupKeyHandlers =
    function setupKeyHandlersWithPiGenticAbort(...args) {
      const result = state.hostSetupKeyHandlers?.apply(this, args);
      const nativeEscape = this.defaultEditor?.onEscape;

      if (typeof nativeEscape !== "function") return result;
      this.defaultEditor.onEscape = () => {
        const sessionId = this.session?.sessionManager?.getSessionId?.();

        if (
          sessionId &&
          !this.session?.isStreaming &&
          hasAgentCallsForSession(sessionId)
        ) {
          void abortAgentCallsForSession(sessionId, {
            actor: "caller session",
          });
          return;
        }

        return nativeEscape();
      };

      return result;
    };
}

export function livePath(sessionId) {
  return `${LIVE_SESSION_PREFIX}${sessionId}`;
}

const state = getLiveRuntimeState();

/** Creates a Pi AgentSessionRuntime for a background or reopened session. */
export async function createLiveRuntime({
  cwd,
  sessionManager,
}: {
  cwd: string;
  sessionManager: PiSessionManager;
}): Promise<PiAgentRuntimeHost> {
  const {
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
  } = await piCodingAgent();
  const agentDir = defaultAgentDir();
  const createRuntime = async (options) => {
    const services = await createAgentSessionServices({
      cwd: options.cwd,
      agentDir: options.agentDir,
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      sessionStartEvent: options.sessionStartEvent,
    });

    return {
      session: result.session,
      services,
      diagnostics: services.diagnostics,
      modelFallbackMessage: result.modelFallbackMessage,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager,
  });

  registerLiveRuntime(runtime);

  return runtime;
}

export function registerLiveRuntime(runtime, metadata = {}) {
  const sessionId = runtime.session.sessionManager.getSessionId();

  state.liveRuntimes.set(sessionId, { runtime, metadata });

  return livePath(sessionId);
}

export function unregisterLiveRuntime(sessionId) {
  state.liveRuntimes.delete(sessionId);
}

export function getLiveRuntime(sessionId) {
  return state.liveRuntimes.get(sessionId);
}

export function listLiveRuntimes() {
  return [...state.liveRuntimes.entries()].map(([sessionId, value]) => ({
    sessionId,
    ...value,
  }));
}

const runtimeSessions = new Map<string, PiRuntimeSession>();

export function getRuntimeSession(sessionId: string) {
  return runtimeSessions.get(sessionId);
}

export function findRuntimeSession(predicate: (runtime: PiRuntimeSession) => boolean) {
  return [...runtimeSessions.values()].find(predicate);
}

/** Registers the latest known runtime state for session discovery and status. */
export function setRuntimeSession(sessionId: string, runtime: PiRuntimeSession) {
  const existing = runtimeSessions.get(sessionId);
  const next = existing ?? runtime;

  Object.assign(next, runtime, { lastSeenAt: Date.now() });
  runtimeSessions.set(sessionId, next);
  pruneRuntimeSessions();

  return next;
}

export function updateRuntimeSession(sessionId: string, patch: Partial<PiRuntimeSession>) {
  const existing = runtimeSessions.get(sessionId);

  if (!existing) return undefined;

  return setRuntimeSession(sessionId, { ...existing, ...patch });
}

export function listRuntimeSessions() {
  return [...runtimeSessions.values()];
}

export function deleteRuntimeSession(sessionId: string) {
  runtimeSessions.delete(sessionId);
}

export function pruneRuntimeSessions({
  maxEntries = 100,
  maxIdleMs = 12 * 60 * 60_000,
} = {}) {
  const now = Date.now();

  for (const [sessionId, runtime] of runtimeSessions) {
    const running = runtime.session?.isStreaming === true;
    const lastSeenAt = Number(runtime.lastSeenAt ?? 0);

    if (!running && lastSeenAt && now - lastSeenAt > maxIdleMs)
      runtimeSessions.delete(sessionId);
  }

  const entries = [...runtimeSessions.entries()];

  if (entries.length <= maxEntries) return;
  const removable = entries
    .filter(([, runtime]) => runtime.session?.isStreaming !== true)
    .sort(
      ([, a], [, b]) => Number(a.lastSeenAt ?? 0) - Number(b.lastSeenAt ?? 0),
    );

  for (const [sessionId] of removable.slice(
    0,
    Math.max(0, entries.length - maxEntries),
  ))
    runtimeSessions.delete(sessionId);
}

export function persistSessionImmediately(sessionManager) {
  if (typeof sessionManager._rewriteFile === "function")
    sessionManager._rewriteFile();
  sessionManager.flushed = true;
}

export function resolveModelFromRegistry(modelRegistry, modelName) {
  const available = modelRegistry.getAvailable();

  if (modelName.includes("/")) {
    const [provider, id] = modelName.split("/", 2);

    return modelRegistry.find(provider, id);
  }

  return (
    available.find((model) => model.id === modelName) ??
    available.find((model) =>
      model.id.toLowerCase().includes(modelName.toLowerCase()),
    )
  );
}

export function inheritedModelForPolicy(policy, inheritedModel) {
  if (policy?.model || !inheritedModel?.provider || !inheritedModel?.id)
    return undefined;
  return { provider: inheritedModel.provider, id: inheritedModel.id };
}

export async function applyInheritedModel(session, policy, inheritedModel) {
  const modelRef = inheritedModelForPolicy(policy, inheritedModel);

  if (!modelRef) return undefined;
  const model =
    session.modelRegistry.find(modelRef.provider, modelRef.id) ??
    inheritedModel;

  if (modelsEqual(session.model, model)) return model;

  await session.setModel(model);

  return model;
}

function modelsEqual(a, b) {
  return a?.provider === b?.provider && a?.id === b?.id;
}
