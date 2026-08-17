import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultAgentDir, getActiveState, isRecord, shortSessionId } from "../../../catalog.js";
import { reportRuntimeDiagnostic } from "../../../diagnostics.js";
import type {
  PiAgentRuntimeHost,
  PiAgentSession,
  PiApi,
  PiContext,
  PiRuntimeSession,
  PiSessionManager,
  PiTheme,
} from "../../../pi-types.js";
import { HostCapabilityUnavailable, HostVersionUnsupported } from "../../../domain/errors.js";
import type { DelegationId } from "../../../domain/identifiers.js";
import {
  activeDelegationMap,
  createDelegationId,
  getActiveDelegation,
  listActiveDelegations,
  registerActiveDelegation,
  settleActiveDelegation,
  type ActiveDelegation,
  type RegisterActiveDelegation,
} from "../../runtime/DelegationRegistry.js";

type LegacyRecord = Record<string, any>;

type LiveRuntimeState = {
  liveRuntimes: Map<string, LegacyRecord>;
  runtimeSessions: Map<string, PiRuntimeSession>;
  activeCalls: ReadonlyMap<DelegationId, ActiveDelegation>;
  sessionTransitions: WeakMap<object, Promise<unknown>>;
  compatibilityDiagnostics: string[];
  hostSwitchSession?: (this: unknown, sessionPath: string, options?: LegacyRecord) => Promise<unknown>;
  hostNewSession?: (this: unknown, options?: LegacyRecord) => Promise<unknown>;
  hostAbortSession?: (this: unknown, ...args: unknown[]) => Promise<unknown>;
  hostPromptSession?: (this: unknown, ...args: unknown[]) => Promise<unknown>;
  hostSetupKeyHandlers?: (this: unknown, ...args: unknown[]) => unknown;
  hostSetupEditorSubmitHandler?: (this: unknown, ...args: unknown[]) => unknown;
  hostRenderCurrentSessionState?: (this: unknown, ...args: unknown[]) => unknown;
  activeContext?: PiContext;
  activeSession?: PiAgentSession;
  activeApi?: PiApi;
  bridgeInstalled: boolean;
  newSessionBridgeInstalled: boolean;
  abortBridgeInstalled: boolean;
  promptBridgeInstalled: boolean;
  disposeBridgeInstalled: boolean;
  escapeBridgeInstalled: boolean;
  submitBridgeInstalled: boolean;
  liveHydrationBridgeInstalled: boolean;
};

export type PiCodingAgentPeer = {
  version: string;
  diagnostics?: string[];
  AgentSession: { prototype: LegacyRecord };
  theme?: PiTheme;
  AgentSessionRuntime: { prototype: LegacyRecord };
  InteractiveMode?: { prototype?: LegacyRecord };
  SessionManager?: LegacyRecord;
  createAgentSessionFromServices: (options: LegacyRecord) => Promise<{
    session: PiAgentSession;
    modelFallbackMessage?: string;
  }>;
  createAgentSessionRuntime: (
    createRuntime: (options: LegacyRecord) => Promise<LegacyRecord>,
    options: LegacyRecord,
  ) => Promise<PiAgentRuntimeHost>;
  createAgentSessionServices: (options: LegacyRecord) => Promise<LegacyRecord>;
};

let peerModule: Promise<PiCodingAgentPeer> | undefined;

export async function loadPiCodingAgentPeer(): Promise<PiCodingAgentPeer> {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
  const managedCli = path.join(
    localAppData,
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
    ...indexFiles.map((file) => pathToFileURL(file).href),
    "@earendil-works/pi-coding-agent",
  ]);

  return peerModule;
}

async function importFirst(specifiers: string[]): Promise<PiCodingAgentPeer> {
  const errors: unknown[] = [];

  for (const specifier of [...new Set(specifiers)]) {
    try {
      const peer = await import(specifier);
      const resolved = specifier.startsWith("file:") ? specifier : import.meta.resolve(specifier);
      const version = await peerPackageVersion(resolved);
      const diagnostics: string[] = [];
      let theme: PiTheme | undefined;

      try {
        const themeModule = await import(new URL("./modes/interactive/theme/theme.js", resolved).href);
        theme = themeModule.theme;
      } catch (error) {
        diagnostics.push(`Could not load the Pi theme: ${String(error)}`);
      }

      return {
        ...peer,
        version,
        diagnostics,
        theme,
      } as unknown as PiCodingAgentPeer;
    } catch (error) {
      errors.push(error);
    }
  }

  throw new AggregateError(errors, "Could not load a compatible Pi coding-agent runtime.");
}

async function peerPackageVersion(resolvedIndex: string) {
  const packageModule = await import(new URL("../package.json", resolvedIndex).href, { with: { type: "json" } });
  const manifest = packageModule.default;

  if (!isRecord(manifest) || typeof manifest.version !== "string")
    throw new Error("Could not determine the Pi coding-agent version.");
  return manifest.version;
}

const LIVE_RUNTIME_STATE_KEY = Symbol.for("pi-gentic.live-runtime-state");

export function getLiveRuntimeState(): LiveRuntimeState {
  const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
  const state = (globalState[LIVE_RUNTIME_STATE_KEY] ??= {
    liveRuntimes: new Map(),
    hostSwitchSession: undefined,
    hostNewSession: undefined,
    hostAbortSession: undefined,
    hostPromptSession: undefined,
    hostSetupKeyHandlers: undefined,
    hostSetupEditorSubmitHandler: undefined,
    hostRenderCurrentSessionState: undefined,
    activeContext: undefined,
    activeSession: undefined,
    activeApi: undefined,
    bridgeInstalled: false,
    newSessionBridgeInstalled: false,
    abortBridgeInstalled: false,
    promptBridgeInstalled: false,
    disposeBridgeInstalled: false,
    escapeBridgeInstalled: false,
    submitBridgeInstalled: false,
    liveHydrationBridgeInstalled: false,
  }) as LiveRuntimeState;

  state.runtimeSessions ??= new Map();
  state.activeCalls = activeDelegationMap();
  state.sessionTransitions ??= new WeakMap();
  state.compatibilityDiagnostics ??= [];

  return state;
}

type AbortState = {
  sessions: Set<unknown>;
  calls: Set<unknown>;
};

type RegisterAgentCall = Omit<RegisterActiveDelegation, "id" | "completionMode"> & {
  readonly id?: DelegationId;
  readonly completionMode?: RegisterActiveDelegation["completionMode"];
};

export function registerAgentCall(call: RegisterAgentCall) {
  const { id = createDelegationId(), completionMode = "detached", ...delegation } = call;

  return registerActiveDelegation({ ...delegation, id, completionMode });
}

export function hasAgentCallsForSession(sessionId: unknown) {
  return activeCallsForSession(sessionId).length > 0;
}

export function assertNoAgentCallCycle(callerSessionId: unknown, targetSessionId: unknown) {
  const caller = String(callerSessionId ?? "");
  const target = String(targetSessionId ?? "");

  if (!caller || !target) return;
  const targetsByCaller = new Map<string, Set<string>>();

  for (const call of listActiveDelegations()) {
    if (!call.callerSessionId || !call.targetSessionId) continue;
    const targets = targetsByCaller.get(call.callerSessionId) ?? new Set<string>();

    targets.add(call.targetSessionId);
    targetsByCaller.set(call.callerSessionId, targets);
  }

  const pending = [target];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const sessionId = pending.pop();

    if (!sessionId || visited.has(sessionId)) continue;
    if (sessionId === caller)
      throw new Error(
        `Cannot send from session ${shortSessionId(caller)} to session ${shortSessionId(target)} because it would create an active delegation cycle. Wait for the active request to finish before messaging that session.`,
      );
    visited.add(sessionId);
    pending.push(...(targetsByCaller.get(sessionId) ?? []));
  }
}

function hasCancellableAgentCallsForSession(sessionId: unknown) {
  return activeCallsForSession(sessionId).some((call) => call.isCancellable?.() !== false);
}

export async function abortAgentCall(callId: string, options: LegacyRecord = {}) {
  const call = getActiveDelegation(callId);

  return abortCalls(call ? [call] : [], options);
}

export async function abortAgentCallsForSession(sessionId: unknown, options: LegacyRecord = {}) {
  return abortCalls(activeCallsForSession(sessionId), options);
}

function activeCallsForSession(sessionId: unknown) {
  const sessionIds = sessionSubtreeIds(sessionId);

  return listActiveDelegations().filter(
    (call) =>
      (call.callerSessionId !== undefined && sessionIds.has(call.callerSessionId)) ||
      (call.targetSessionId !== undefined && sessionIds.has(call.targetSessionId)),
  );
}

function sessionSubtreeIds(sessionId: unknown) {
  const rootSessionId = String(sessionId ?? "");
  const subtree = new Set<string>(rootSessionId ? [rootSessionId] : []);

  if (!rootSessionId) return subtree;
  const children = new Map<string, string[]>();
  const runtimes = [...getLiveRuntimeState().runtimeSessions.values()];
  const sessionIdsByPath = new Map(
    runtimes.flatMap((runtime) => {
      const id = runtime.session.sessionManager.getSessionId?.();
      const file = normalizeSessionPath(runtime.session.sessionManager.getSessionFile?.());

      return typeof id === "string" && file ? [[file, id]] : [];
    }),
  );

  for (const runtime of runtimes) {
    const id = runtime.session.sessionManager.getSessionId?.();
    const parentPath = runtime.parentSessionPath ?? runtime.session.sessionManager.getHeader?.()?.parentSession;
    const parentId = runtime.parentSessionId ?? sessionIdsByPath.get(normalizeSessionPath(parentPath) ?? "");

    if (typeof id !== "string" || typeof parentId !== "string") continue;
    children.set(parentId, [...(children.get(parentId) ?? []), id]);
  }

  const pending = [rootSessionId];

  while (pending.length > 0) {
    const parentId = pending.pop();

    if (!parentId) continue;
    for (const childId of children.get(parentId) ?? []) {
      if (subtree.has(childId)) continue;
      subtree.add(childId);
      pending.push(childId);
    }
  }

  return subtree;
}

function normalizeSessionPath(value: unknown) {
  if (typeof value !== "string" || !value) return undefined;
  const normalized = path.resolve(value);

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function abortCalls(calls: ReadonlyArray<ActiveDelegation>, options: LegacyRecord = {}) {
  const state = isAbortState(options.state) ? options.state : { sessions: new Set(), calls: new Set() };
  let aborted = 0;

  for (const call of calls) {
    if (!call || state.calls.has(call.id)) continue;
    state.calls.add(call.id);

    try {
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
    } finally {
      settleActiveDelegation(call.id);
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

export async function installLiveSessionBridge() {
  const state = getLiveRuntimeState();

  state.compatibilityDiagnostics.length = 0;

  try {
    const peer = await loadPiCodingAgentPeer();

    assertLegacyHostCompatible(peer);
    for (const diagnostic of peer.diagnostics ?? []) {
      if (!state.compatibilityDiagnostics.includes(diagnostic)) state.compatibilityDiagnostics.push(diagnostic);
    }
    installRuntimeSwitchBridge(state, peer);
    installRuntimeNewSessionBridge(state, peer);
    installSessionAbortBridge(state, peer);
    installSessionPromptBridge(state, peer);
    installSessionDisposeBridge(state, peer);
    installInteractiveEscapeBridge(state, peer);
    installInteractiveSubmitBridge(state, peer);
    installInteractiveLiveSessionHydrationBridge(state, peer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!state.compatibilityDiagnostics.includes(message)) state.compatibilityDiagnostics.push(message);
  }
}

export function hostCompatibilityDiagnostics() {
  return [...getLiveRuntimeState().compatibilityDiagnostics];
}

const LEGACY_HOST_VERSION = "0.84.2";

export function assertLegacyHostCompatible(peer: PiCodingAgentPeer) {
  if (peer.version !== LEGACY_HOST_VERSION)
    throw HostVersionUnsupported.make({
      message: `The pi-gentic legacy bridge supports Pi ${LEGACY_HOST_VERSION}; received ${peer.version}.`,
      supportedVersion: LEGACY_HOST_VERSION,
      receivedVersion: peer.version,
    });

  const required: Array<[LegacyRecord | undefined, string, string]> = [
    [peer.AgentSessionRuntime?.prototype, "switchSession", "AgentSessionRuntime"],
    [peer.AgentSessionRuntime?.prototype, "newSession", "AgentSessionRuntime"],
    [peer.AgentSession?.prototype, "abort", "AgentSession"],
    [peer.AgentSession?.prototype, "prompt", "AgentSession"],
    [peer.AgentSession?.prototype, "dispose", "AgentSession"],
    [peer.InteractiveMode?.prototype, "setupEditorSubmitHandler", "InteractiveMode"],
    [peer.InteractiveMode?.prototype, "setupKeyHandlers", "InteractiveMode"],
    [peer.InteractiveMode?.prototype, "renderCurrentSessionState", "InteractiveMode"],
  ];
  const missing = required
    .filter(([prototype, method]) => typeof prototype?.[method] !== "function")
    .map(([, method, owner]) => `${owner}.${method}`);

  if (missing.length > 0)
    throw HostCapabilityUnavailable.make({
      message: `Pi runtime compatibility check failed: ${missing.join(", ")}.`,
      capability: missing.join(", "),
      hostVersion: peer.version,
    });
}

function installRuntimeSwitchBridge(
  state: LiveRuntimeState,
  { AgentSessionRuntime }: Pick<PiCodingAgentPeer, "AgentSessionRuntime">,
) {
  if (state.bridgeInstalled) return;
  state.bridgeInstalled = true;
  state.hostSwitchSession = AgentSessionRuntime.prototype.switchSession as LiveRuntimeState["hostSwitchSession"];
  AgentSessionRuntime.prototype.switchSession = async function switchSessionWithLiveRuntime(
    sessionPath: string,
    options?: LegacyRecord,
  ) {
    return trackSessionTransition(state, this, async () => {
      const switchOptions = withVisibleContextTracking(state, this, options);

      if (typeof sessionPath !== "string" || !sessionPath.startsWith(LIVE_SESSION_PREFIX))
        return switchPersistedSession(state, this, sessionPath, switchOptions);

      const sessionId = sessionPath.slice(LIVE_SESSION_PREFIX.length);
      const live = state.liveRuntimes.get(sessionId) as
        | { runtime: PiAgentRuntimeHost; metadata?: LegacyRecord }
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
  runtimeHost: LegacyRecord,
  sessionPath: string,
  options: LegacyRecord,
) {
  const restore = parkCurrentLiveRuntimeForSwitch(state, runtimeHost);

  try {
    return await state.hostSwitchSession?.call(runtimeHost, sessionPath, options);
  } finally {
    restore();
  }
}

function installRuntimeNewSessionBridge(
  state: LiveRuntimeState,
  { AgentSessionRuntime }: Pick<PiCodingAgentPeer, "AgentSessionRuntime">,
) {
  if (state.newSessionBridgeInstalled) return;
  state.newSessionBridgeInstalled = true;
  state.hostNewSession = AgentSessionRuntime.prototype.newSession as LiveRuntimeState["hostNewSession"];
  AgentSessionRuntime.prototype.newSession = async function newSessionWithLiveRuntime(options?: LegacyRecord) {
    return trackSessionTransition(state, this, async () => {
      const restore = parkCurrentLiveRuntimeForSwitch(state, this);

      try {
        return await state.hostNewSession?.call(this, withVisibleContextTracking(state, this, options));
      } finally {
        restore();
      }
    });
  };
}

/** Keeps editor submissions bound to the session selected by an in-flight host replacement. */
async function trackSessionTransition<T>(state: LiveRuntimeState, runtimeHost: object, transition: () => Promise<T>) {
  const pending = transition();

  state.sessionTransitions.set(runtimeHost, pending);

  try {
    return await pending;
  } finally {
    if (state.sessionTransitions.get(runtimeHost) === pending) state.sessionTransitions.delete(runtimeHost);
  }
}

function pendingSessionTransition(state: LiveRuntimeState, runtimeHost: unknown) {
  if ((typeof runtimeHost !== "object" && typeof runtimeHost !== "function") || runtimeHost === null) return undefined;

  return state.sessionTransitions.get(runtimeHost);
}

function withVisibleContextTracking(state: LiveRuntimeState, runtimeHost: LegacyRecord, options: LegacyRecord = {}) {
  const originalWithSession = options.withSession;

  return {
    ...options,
    async withSession(nextCtx: PiContext) {
      state.activeContext = nextCtx;
      state.activeSession = runtimeHost.session;

      if (typeof originalWithSession === "function") await originalWithSession(nextCtx);
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

const noop = () => {};
const noopAsync = async () => {};

function parkMethod(target: LegacyRecord, method: string, replacement: (...args: unknown[]) => unknown) {
  const original = target[method];

  if (typeof original !== "function") return noop;
  target[method] = replacement;

  return () => {
    if (target[method] === replacement) target[method] = original;
  };
}

export function runtimeSessionIsRunning(runtime: PiRuntimeSession | undefined) {
  return Boolean(runtime && (runtime.session.isStreaming === true || Number(runtime.activePromptCount ?? 0) > 0));
}

export function parkCurrentLiveRuntimeForSwitch(state: LiveRuntimeState, runtimeHost: LegacyRecord | undefined) {
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
    ...(tracked ?? {}),
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

function snapshotRuntimeHost(runtimeHost: LegacyRecord | undefined, session: LegacyRecord) {
  if (!runtimeHost) return undefined;

  return {
    session,
    services: runtimeHost.services,
    diagnostics: runtimeHost.diagnostics,
    modelFallbackMessage: runtimeHost.modelFallbackMessage,
  } as PiAgentRuntimeHost;
}

function installSessionAbortBridge(state: LiveRuntimeState, { AgentSession }: Pick<PiCodingAgentPeer, "AgentSession">) {
  if (state.abortBridgeInstalled) return;
  state.abortBridgeInstalled = true;
  state.hostAbortSession = AgentSession.prototype.abort as LiveRuntimeState["hostAbortSession"];

  AgentSession.prototype.abort = async function abortWithPiGenticTargets(...args: unknown[]) {
    const sessionId = this.sessionManager.getSessionId?.();

    await abortAgentCallsForSession(sessionId, {
      actor: "aborted session",
      skipSessionAbort: sessionId,
    });

    return state.hostAbortSession?.apply(this, args);
  };
}

function installSessionPromptBridge(
  state: LiveRuntimeState,
  { AgentSession }: Pick<PiCodingAgentPeer, "AgentSession">,
) {
  if (state.promptBridgeInstalled) return;
  state.promptBridgeInstalled = true;
  state.hostPromptSession = AgentSession.prototype.prompt as LiveRuntimeState["hostPromptSession"];

  AgentSession.prototype.prompt = async function promptWithPiGenticRuntime(...args: unknown[]) {
    return trackSessionPrompt(this, () => state.hostPromptSession?.apply(this, args), args[0]);
  };
}

function installSessionDisposeBridge(
  state: LiveRuntimeState,
  { AgentSession }: Pick<PiCodingAgentPeer, "AgentSession">,
) {
  if (state.disposeBridgeInstalled) return;
  state.disposeBridgeInstalled = true;
  const dispose = AgentSession.prototype.dispose;

  AgentSession.prototype.dispose = function disposeWithPiGenticRuntimeCleanup(...args: unknown[]) {
    const sessionId = this.sessionManager?.getSessionId?.();

    try {
      return dispose?.apply(this, args);
    } finally {
      if (typeof sessionId === "string" && sessionId) {
        unregisterLiveRuntime(sessionId);
        deleteRuntimeSession(sessionId);
      }
    }
  };
}

export async function trackSessionPrompt<T>(session: LegacyRecord, run: () => Promise<T> | T, prompt?: unknown) {
  const sessionId = session.sessionManager?.getSessionId?.();
  const lastMessage = promptLastMessage(prompt);
  const mark = (promptCountDelta: number) => {
    if (!sessionId) return undefined;
    const activePromptCount = Math.max(
      0,
      Number(getRuntimeSession(sessionId)?.activePromptCount ?? 0) + promptCountDelta,
    );

    return setRuntimeSession(sessionId, {
      session: session as PiAgentSession,
      ...(lastMessage ? { lastMessage } : {}),
      agentName: getActiveState(session.sessionManager).agentName,
      parentSessionPath: session.sessionManager?.getHeader?.()?.parentSession,
      lastActivityAt: new Date().toISOString(),
      activePromptCount,
    });
  };

  mark(1);

  try {
    return await run();
  } finally {
    const runtime = mark(-1);

    if (sessionId && !runtimeSessionIsRunning(runtime)) unregisterLiveRuntime(sessionId);
  }
}

function promptLastMessage(prompt: unknown) {
  const text = typeof prompt === "string" ? prompt.trim() : "";

  return text && !text.startsWith("/") ? text : undefined;
}

function installInteractiveSubmitBridge(
  state: LiveRuntimeState,
  { InteractiveMode }: Pick<PiCodingAgentPeer, "InteractiveMode">,
) {
  if (state.submitBridgeInstalled || !InteractiveMode?.prototype?.setupEditorSubmitHandler) return;
  state.submitBridgeInstalled = true;
  state.hostSetupEditorSubmitHandler = InteractiveMode.prototype
    .setupEditorSubmitHandler as LiveRuntimeState["hostSetupEditorSubmitHandler"];
  InteractiveMode.prototype.setupEditorSubmitHandler = function setupEditorSubmitHandlerWithPiGenticCommands(
    ...args: unknown[]
  ) {
    const result = state.hostSetupEditorSubmitHandler?.apply(this, args);
    const nativeSubmit = this.defaultEditor?.onSubmit;

    if (typeof nativeSubmit !== "function") return result;
    this.defaultEditor.onSubmit = async (text: unknown) => {
      const transition = pendingSessionTransition(state, this.runtimeHost);
      if (transition) await transition.catch(noop);
      const command = String(text ?? "").trim();

      if (shouldPromptVisibleSessionBeforeNative(this, command)) {
        await promptVisibleSessionNow(this, command, { addHistory: true });
        return;
      }

      const fallbackAfterNative = shouldPromptVisibleSessionAfterNative(this, command);
      const submittedEditor = this.editor;
      const submittedText = editorText(submittedEditor);
      const pendingInputs = Array.isArray(this.pendingUserInputs) ? this.pendingUserInputs : undefined;
      const pendingInputCount = pendingInputs?.length ?? 0;
      const addedPendingInputs = fallbackAfterNative && !pendingInputs;
      if (addedPendingInputs) this.pendingUserInputs = [];
      const result = await nativeSubmit(text);

      if (
        fallbackAfterNative &&
        shouldPromptVisibleSessionNow(this, command) &&
        this.editor === submittedEditor &&
        sameSubmittedText(editorText(submittedEditor), command) &&
        sameSubmittedText(submittedText, command)
      ) {
        removeSubmittedPendingInput(this, command, pendingInputCount);
        await promptVisibleSessionNow(this, command, {
          addHistory: false,
          flushPendingBash: false,
        });
      }

      if (addedPendingInputs && this.pendingUserInputs?.length === 0) delete this.pendingUserInputs;

      return result;
    };

    return result;
  };
}

function shouldPromptVisibleSessionBeforeNative(mode: LegacyRecord, text: string) {
  if (!shouldPromptVisibleSessionNow(mode, text)) return false;

  return !text.startsWith("/") || isVisibleExtensionCommand(mode, text);
}

function shouldPromptVisibleSessionAfterNative(mode: LegacyRecord, text: string) {
  return Boolean(
    text.startsWith("/") && !isVisibleExtensionCommand(mode, text) && shouldPromptVisibleSessionNow(mode, text),
  );
}

export function shouldPromptVisibleSessionNow(mode: LegacyRecord, text: string) {
  const session = mode?.session as LegacyRecord | undefined;

  return Boolean(
    String(text ?? "").trim() &&
    session &&
    session.isStreaming !== true &&
    session.isCompacting !== true &&
    typeof mode.onInputCallback !== "function" &&
    hasOtherStreamingRuntime(session),
  );
}

export function shouldRunVisibleExtensionCommandNow(mode: LegacyRecord, text: string) {
  return Boolean(shouldPromptVisibleSessionNow(mode, text) && isVisibleExtensionCommand(mode, text));
}

async function promptVisibleSessionNow(mode: LegacyRecord, text: string, options: LegacyRecord = {}) {
  if (options.flushPendingBash !== false) mode.flushPendingBashComponents?.();

  if (options.addHistory !== false) mode.editor?.addToHistory?.(text);
  mode.editor?.setText?.("");
  await mode.session.prompt(text);
  mode.updatePendingMessagesDisplay?.();
  mode.ui?.requestRender?.();
}

function isVisibleExtensionCommand(mode: LegacyRecord, text: string) {
  if (!text.startsWith("/")) return false;
  if (typeof mode.isExtensionCommand === "function") {
    try {
      return mode.isExtensionCommand(text) === true;
    } catch (error) {
      reportRuntimeDiagnostic("legacy-extension-command", error);
      return false;
    }
  }

  const commandName = text.slice(1).split(/\s/, 1)[0];
  const extensionRunner = mode.session?.extensionRunner as LegacyRecord | undefined;
  const getCommand = extensionRunner?.getCommand;

  return Boolean(typeof getCommand === "function" && getCommand.call(extensionRunner, commandName));
}

function hasOtherStreamingRuntime(session: LegacyRecord) {
  const visibleSessionId = session.sessionManager?.getSessionId?.();

  return Boolean(
    visibleSessionId &&
    listRuntimeSessions().some(
      (runtime) =>
        runtimeSessionIsRunning(runtime) && runtime.session.sessionManager?.getSessionId?.() !== visibleSessionId,
    ),
  );
}

function removeSubmittedPendingInput(mode: LegacyRecord, submitted: string, originalLength: number) {
  if (!Array.isArray(mode.pendingUserInputs)) return;
  const appended = mode.pendingUserInputs.slice(originalLength);
  if (appended.length === 1 && sameSubmittedText(appended[0], submitted))
    mode.pendingUserInputs.splice(originalLength, 1);
}

function editorText(editor: LegacyRecord) {
  try {
    return typeof editor?.getText === "function" ? editor.getText() : undefined;
  } catch (error) {
    reportRuntimeDiagnostic("legacy-editor-text", error);
    return undefined;
  }
}

function sameSubmittedText(value: unknown, submitted: string) {
  return String(value ?? "").trim() === submitted;
}

export function handleInteractiveEscape({
  sessionId,
  isStreaming,
  nativeEscape,
}: {
  sessionId?: string;
  isStreaming?: boolean;
  nativeEscape: () => unknown;
}) {
  if (sessionId && !isStreaming && hasCancellableAgentCallsForSession(sessionId)) {
    void abortAgentCallsForSession(sessionId, { actor: "caller session" });
    return;
  }

  return nativeEscape();
}

function installInteractiveEscapeBridge(
  state: LiveRuntimeState,
  { InteractiveMode }: Pick<PiCodingAgentPeer, "InteractiveMode">,
) {
  if (state.escapeBridgeInstalled || !InteractiveMode?.prototype?.setupKeyHandlers) return;
  state.escapeBridgeInstalled = true;
  state.hostSetupKeyHandlers = InteractiveMode.prototype.setupKeyHandlers as LiveRuntimeState["hostSetupKeyHandlers"];
  InteractiveMode.prototype.setupKeyHandlers = function setupKeyHandlersWithPiGenticAbort(...args: unknown[]) {
    const result = state.hostSetupKeyHandlers?.apply(this, args);
    const nativeEscape = this.defaultEditor?.onEscape;

    if (typeof nativeEscape !== "function") return result;
    this.defaultEditor.onEscape = () =>
      handleInteractiveEscape({
        sessionId: this.session?.sessionManager?.getSessionId?.(),
        isStreaming: this.session?.isStreaming,
        nativeEscape,
      });

    return result;
  };
}

function installInteractiveLiveSessionHydrationBridge(
  state: LiveRuntimeState,
  { InteractiveMode }: Pick<PiCodingAgentPeer, "InteractiveMode">,
) {
  if (state.liveHydrationBridgeInstalled || !InteractiveMode?.prototype?.renderCurrentSessionState) return;
  state.liveHydrationBridgeInstalled = true;
  state.hostRenderCurrentSessionState = InteractiveMode.prototype
    .renderCurrentSessionState as LiveRuntimeState["hostRenderCurrentSessionState"];
  InteractiveMode.prototype.renderCurrentSessionState = function renderCurrentSessionStateWithLiveHydration(
    ...args: unknown[]
  ) {
    const result = state.hostRenderCurrentSessionState?.apply(this, args);
    replayCurrentStreamingMessage(this);
    return result;
  };
}

function replayCurrentStreamingMessage(mode: LegacyRecord) {
  const session = mode?.session;
  const agentState = session?.state ?? session?.agent?.state;
  const streamingMessage = agentState?.streamingMessage;

  if (session?.isStreaming !== true || streamingMessage?.role !== "assistant" || typeof mode.handleEvent !== "function")
    return false;

  replayStreamingMessage(mode, streamingMessage);
  return true;
}

function replayStreamingMessage(mode: LegacyRecord, message: LegacyRecord) {
  void mode.handleEvent({ type: "message_start", message });
  void mode.handleEvent({ type: "message_update", message });
}

export function livePath(sessionId: unknown) {
  return `${LIVE_SESSION_PREFIX}${sessionId}`;
}

const state = getLiveRuntimeState();

export async function createLiveRuntime({
  cwd,
  sessionManager,
}: {
  cwd: string;
  sessionManager: PiSessionManager;
}): Promise<PiAgentRuntimeHost> {
  const { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices } =
    await loadPiCodingAgentPeer();
  const agentDir = defaultAgentDir();
  const createRuntime = async (options: LegacyRecord) => {
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

export function registerLiveRuntime(runtime: LegacyRecord, metadata: LegacyRecord = {}) {
  const sessionId = runtime.session.sessionManager.getSessionId();

  state.liveRuntimes.set(sessionId, { runtime, metadata });

  return livePath(sessionId);
}

export function unregisterLiveRuntime(sessionId: string) {
  state.liveRuntimes.delete(sessionId);
}

export function getRuntimeSession(sessionId: string) {
  return getLiveRuntimeState().runtimeSessions.get(sessionId);
}

export function findRuntimeSession(predicate: (runtime: PiRuntimeSession) => boolean) {
  return [...getLiveRuntimeState().runtimeSessions.values()].find(predicate);
}

const RUNTIME_ACTIVITY_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
]);

export function isSessionActivityEvent(event: unknown) {
  return Boolean(
    event && typeof event === "object" && RUNTIME_ACTIVITY_EVENTS.has(String((event as LegacyRecord).type ?? "")),
  );
}

function syncRuntimeActivityTracking(sessionId: string, runtime: PiRuntimeSession) {
  const session = runtime.session;

  if (runtime.activitySession === session) return;
  stopRuntimeActivityTracking(runtime);

  if (!session || typeof session.subscribe !== "function") return;
  runtime.activitySession = session;
  runtime.activityUnsubscribe = session.subscribe((event: unknown) => {
    if (!isSessionActivityEvent(event)) return;
    const current = getRuntimeSession(sessionId);

    if (current !== runtime || current.session !== session) return;
    runtime.lastActivityAt = new Date(Date.now()).toISOString();
  });
}

function stopRuntimeActivityTracking(runtime: PiRuntimeSession | undefined) {
  runtime?.activityUnsubscribe?.();

  if (!runtime) return;
  delete runtime.activityUnsubscribe;
  delete runtime.activitySession;
}

export function setRuntimeSession(sessionId: string, runtime: PiRuntimeSession) {
  const runtimeSessions = getLiveRuntimeState().runtimeSessions;
  const existing = runtimeSessions.get(sessionId);
  const next = existing ?? runtime;

  Object.assign(next, runtime, { lastSeenAt: Date.now() });
  runtimeSessions.set(sessionId, next);
  syncRuntimeActivityTracking(sessionId, next);
  pruneRuntimeSessions();

  return next;
}

export function listRuntimeSessions() {
  return [...getLiveRuntimeState().runtimeSessions.values()];
}

export function deleteRuntimeSession(sessionId: string) {
  const runtimeSessions = getLiveRuntimeState().runtimeSessions;

  stopRuntimeActivityTracking(runtimeSessions.get(sessionId));
  runtimeSessions.delete(sessionId);
}

export function pruneRuntimeSessions({ maxEntries = 100, maxIdleMs = 12 * 60 * 60_000 } = {}) {
  const now = Date.now();
  const runtimeSessions = getLiveRuntimeState().runtimeSessions;

  for (const [sessionId, runtime] of runtimeSessions) {
    const running = runtime.session?.isStreaming === true;
    const lastSeenAt = Number(runtime.lastSeenAt ?? 0);

    if (!running && lastSeenAt && now - lastSeenAt > maxIdleMs) deleteRuntimeSession(sessionId);
  }

  const entries = [...runtimeSessions.entries()];

  if (entries.length <= maxEntries) return;
  const removable = entries
    .filter(([, runtime]) => !runtimeSessionIsRunning(runtime))
    .sort(([, a], [, b]) => Number(a.lastSeenAt ?? 0) - Number(b.lastSeenAt ?? 0));

  for (const [sessionId] of removable.slice(0, Math.max(0, entries.length - maxEntries)))
    deleteRuntimeSession(sessionId);
}

export function persistSessionImmediately(sessionManager: PiSessionManager) {
  const legacyManager = sessionManager as unknown as LegacyRecord;

  if (typeof legacyManager._rewriteFile === "function") legacyManager._rewriteFile();
  legacyManager.flushed = true;
}

export function resolveModelFromCatalog(modelCatalog: LegacyRecord, modelName: string) {
  if (modelName.includes("/")) {
    const [provider, id] = modelName.split("/", 2);

    return modelCatalog.find?.(provider, id) ?? modelCatalog.getModel?.(provider, id);
  }

  const available = modelCatalog.getAvailableSnapshot?.() ?? modelCatalog.getAvailable?.();
  const models = Array.isArray(available) ? available : (modelCatalog.getModels?.() ?? []);

  return (
    models.find((model: LegacyRecord) => model.id === modelName) ??
    models.find((model: LegacyRecord) => model.id.toLowerCase().includes(modelName.toLowerCase()))
  );
}

export function inheritedModelForPolicy(policy: LegacyRecord, inheritedModel: LegacyRecord | undefined) {
  if (policy?.model || !inheritedModel?.provider || !inheritedModel?.id) return undefined;
  return { provider: inheritedModel.provider, id: inheritedModel.id };
}

export async function applyInheritedModel(
  session: PiAgentSession,
  policy: LegacyRecord,
  inheritedModel: LegacyRecord | undefined,
) {
  const modelRef = inheritedModelForPolicy(policy, inheritedModel);

  if (!modelRef) return undefined;
  const model =
    resolveModelFromCatalog(
      (session as unknown as LegacyRecord).modelRegistry ?? session.modelRuntime,
      `${modelRef.provider}/${modelRef.id}`,
    ) ?? inheritedModel;

  if (modelsEqual(session.model, model)) return model;

  await session.setModel(model);

  return model;
}

function modelsEqual(a: LegacyRecord | undefined, b: LegacyRecord | undefined) {
  return a?.provider === b?.provider && a?.id === b?.id;
}
