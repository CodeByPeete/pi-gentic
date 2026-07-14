import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultAgentDir, getActiveState } from "./catalog.js";

type LiveRuntimeState = {
  liveRuntimes: Map<string, AnyRecord>;
  runtimeSessions: Map<string, PiRuntimeSession>;
  activeCalls: Map<string, AgentCall>;
  nextCallId: number;
  compatibilityDiagnostics: string[];
  hostSwitchSession?: (this: unknown, sessionPath: string, options?: AnyRecord) => Promise<unknown>;
  hostNewSession?: (this: unknown, options?: AnyRecord) => Promise<unknown>;
  hostAbortSession?: (this: unknown, ...args: unknown[]) => Promise<unknown>;
  hostPromptSession?: (this: unknown, ...args: unknown[]) => Promise<unknown>;
  hostSetupKeyHandlers?: (this: unknown, ...args: unknown[]) => unknown;
  hostSetupEditorSubmitHandler?: (this: unknown, ...args: unknown[]) => unknown;
  hostRenderCurrentSessionState?: (this: unknown, ...args: unknown[]) => unknown;
  activeContext?: PiContext;
  activeSession?: PiAgentSession;
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
  AgentSession: { prototype: AnyRecord };
  theme?: PiTheme;
  AgentSessionRuntime: { prototype: AnyRecord };
  InteractiveMode?: { prototype?: AnyRecord };
  SessionManager?: AnyRecord;
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
      let theme: PiTheme | undefined;

      try {
        const resolved = specifier.startsWith("file:")
          ? specifier
          : import.meta.resolve(specifier);
        const themeModule = await import(
          new URL("./modes/interactive/theme/theme.js", resolved).href
        );
        theme = themeModule.theme;
      } catch {}

      return { ...peer, theme } as unknown as PiCodingAgentPeer;
    } catch (error) {
      errors.push(error);
    }
  }

  throw new AggregateError(errors, "Could not load a compatible Pi coding-agent runtime.");
}

const LIVE_RUNTIME_STATE_KEY = Symbol.for("pi-gentic.live-runtime-state");

export function getLiveRuntimeState(): LiveRuntimeState {
  const state = (globalThis[LIVE_RUNTIME_STATE_KEY] ??= {
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
  state.activeCalls ??= new Map();
  state.nextCallId ??= 0;
  state.compatibilityDiagnostics ??= [];

  return state;
}

type AgentCall = {
  id: string;
  callerSessionId?: string;
  targetSessionId?: string;
  abort?: (options?: AnyRecord) => Promise<void> | void;
  isCancellable?: () => boolean;
  startedAt?: number;
};

type AbortState = {
  sessions: Set<unknown>;
  calls: Set<unknown>;
};

export function registerAgentCall(call: Omit<AgentCall, "id" | "startedAt"> & { id?: string }) {
  const state = getLiveRuntimeState();
  const id = call.id ?? `agent-call:${++state.nextCallId}`;

  state.activeCalls.set(id, { ...call, id, startedAt: Date.now() });

  return {
    id,
    unregister: () => state.activeCalls.delete(id),
  };
}

export function hasAgentCallsForSession(sessionId) {
  return activeCallsForSession(sessionId).length > 0;
}

function hasCancellableAgentCallsForSession(sessionId) {
  return activeCallsForSession(sessionId).some(
    (call) => call.isCancellable?.() !== false,
  );
}

export async function abortAgentCall(callId, options = {}) {
  const call = getLiveRuntimeState().activeCalls.get(callId);

  return abortCalls(call ? [call] : [], options);
}

export async function abortAgentCallsForSession(sessionId, options = {}) {
  return abortCalls(activeCallsForSession(sessionId), options);
}

function activeCallsForSession(sessionId) {
  return [...getLiveRuntimeState().activeCalls.values()].filter(
    (call) =>
      call.callerSessionId === sessionId || call.targetSessionId === sessionId,
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

export async function installLiveSessionBridge() {
  const state = getLiveRuntimeState();

  try {
    const peer = await loadPiCodingAgentPeer();

    assertCompatibleHost(peer);
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

    if (!state.compatibilityDiagnostics.includes(message))
      state.compatibilityDiagnostics.push(message);
  }
}

export function hostCompatibilityDiagnostics() {
  return [...getLiveRuntimeState().compatibilityDiagnostics];
}

function assertCompatibleHost(peer: PiCodingAgentPeer) {
  const required: Array<[AnyRecord | undefined, string, string]> = [
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
    throw new Error(`Pi runtime compatibility check failed: ${missing.join(", ")}.`);
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

function installRuntimeNewSessionBridge(
  state: LiveRuntimeState,
  { AgentSessionRuntime }: Pick<PiCodingAgentPeer, "AgentSessionRuntime">,
) {
  if (state.newSessionBridgeInstalled) return;
  state.newSessionBridgeInstalled = true;
  state.hostNewSession = AgentSessionRuntime.prototype
    .newSession as LiveRuntimeState["hostNewSession"];
  AgentSessionRuntime.prototype.newSession =
    async function newSessionWithLiveRuntime(options) {
      const restore = parkCurrentLiveRuntimeForSwitch(state, this);

      try {
        return await state.hostNewSession?.call(
          this,
          withVisibleContextTracking(state, this, options),
        );
      } finally {
        restore();
      }
    };
}

function withVisibleContextTracking(
  state: LiveRuntimeState,
  runtimeHost: AnyRecord,
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
  runtimeHost: AnyRecord | undefined,
) {
  const session = runtimeHost?.session;
  const sessionId = session?.sessionManager?.getSessionId?.();
  const tracked = sessionId ? getRuntimeSession(sessionId) : undefined;
  const liveRuntime =
    tracked?.runtimeHost ??
    (session ? snapshotRuntimeHost(runtimeHost, session) : undefined);

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
  const runtime = setRuntimeSession(sessionId, {
    ...(tracked ?? {}),
    runtimeHost: liveRuntime,
    session,
    agentName:
      tracked?.agentName ?? getActiveState(session.sessionManager).agentName,
    parentSessionPath:
      tracked?.parentSessionPath ??
      session.sessionManager.getHeader?.()?.parentSession,
    lastActivityAt: new Date().toISOString(),
  });

  state.liveRuntimes.set(sessionId, {
    runtime: liveRuntime,
    metadata: { agentName: runtime.agentName },
  });
  session.dispose = parkedDispose;

  return () => {
    if (session.dispose !== parkedDispose) return;
    session.dispose = originalDispose;
  };
}

function snapshotRuntimeHost(
  runtimeHost: AnyRecord | undefined,
  session: AnyRecord,
) {
  if (!runtimeHost) return undefined;

  return {
    session,
    services: runtimeHost.services,
    diagnostics: runtimeHost.diagnostics,
    modelFallbackMessage: runtimeHost.modelFallbackMessage,
  } as PiAgentRuntimeHost;
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
  state.hostPromptSession =
    AgentSession.prototype.prompt as LiveRuntimeState["hostPromptSession"];

  AgentSession.prototype.prompt = async function promptWithPiGenticRuntime(
    ...args
  ) {
    return trackSessionPrompt(
      this,
      () => state.hostPromptSession?.apply(this, args),
      args[0],
    );
  };
}

function installSessionDisposeBridge(
  state: LiveRuntimeState,
  { AgentSession }: Pick<PiCodingAgentPeer, "AgentSession">,
) {
  if (state.disposeBridgeInstalled) return;
  state.disposeBridgeInstalled = true;
  const dispose = AgentSession.prototype.dispose;

  AgentSession.prototype.dispose = function disposeWithPiGenticRuntimeCleanup(
    ...args
  ) {
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

export async function trackSessionPrompt<T>(
  session: AnyRecord,
  run: () => Promise<T> | T,
  prompt?: unknown,
) {
  const sessionId = session.sessionManager?.getSessionId?.();
  const lastMessage = promptLastMessage(prompt);
  const mark = () => {
    if (!sessionId) return undefined;
    return setRuntimeSession(sessionId, {
      session,
      ...(lastMessage ? { lastMessage } : {}),
      agentName: getActiveState(session.sessionManager).agentName,
      parentSessionPath: session.sessionManager?.getHeader?.()?.parentSession,
      lastActivityAt: new Date().toISOString(),
    });
  };

  mark();

  try {
    return await run();
  } finally {
    mark();

    if (sessionId && session.isStreaming !== true)
      unregisterLiveRuntime(sessionId);
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
  if (
    state.submitBridgeInstalled ||
    !InteractiveMode?.prototype?.setupEditorSubmitHandler
  )
    return;
  state.submitBridgeInstalled = true;
  state.hostSetupEditorSubmitHandler = InteractiveMode.prototype
    .setupEditorSubmitHandler as LiveRuntimeState["hostSetupEditorSubmitHandler"];
  InteractiveMode.prototype.setupEditorSubmitHandler =
    function setupEditorSubmitHandlerWithPiGenticCommands(...args) {
      const result = state.hostSetupEditorSubmitHandler?.apply(this, args);
      const nativeSubmit = this.defaultEditor?.onSubmit;

      if (typeof nativeSubmit !== "function") return result;
      this.defaultEditor.onSubmit = async (text) => {
        const command = String(text ?? "").trim();

        if (shouldPromptVisibleSessionBeforeNative(this, command)) {
          await promptVisibleSessionNow(this, command, { addHistory: true });
          return;
        }

        const fallbackAfterNative = shouldPromptVisibleSessionAfterNative(
          this,
          command,
        );
        const submittedEditor = this.editor;
        const submittedText = editorText(submittedEditor);
        const pendingInputs = Array.isArray(this.pendingUserInputs)
          ? this.pendingUserInputs
          : undefined;
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

        if (addedPendingInputs && this.pendingUserInputs?.length === 0)
          delete this.pendingUserInputs;

        return result;
      };

      return result;
    };
}

function shouldPromptVisibleSessionBeforeNative(
  mode: AnyRecord,
  text: string,
) {
  if (!shouldPromptVisibleSessionNow(mode, text)) return false;

  return !text.startsWith("/") || isVisibleExtensionCommand(mode, text);
}

function shouldPromptVisibleSessionAfterNative(mode: AnyRecord, text: string) {
  return Boolean(
    text.startsWith("/") &&
      !isVisibleExtensionCommand(mode, text) &&
      shouldPromptVisibleSessionNow(mode, text),
  );
}

export function shouldPromptVisibleSessionNow(mode: AnyRecord, text: string) {
  const session = mode?.session as AnyRecord | undefined;

  return Boolean(
    String(text ?? "").trim() &&
      session &&
      session.isStreaming !== true &&
      session.isCompacting !== true &&
      typeof mode.onInputCallback !== "function" &&
      hasOtherStreamingRuntime(session),
  );
}

export function shouldRunVisibleExtensionCommandNow(mode: AnyRecord, text: string) {
  return Boolean(
    shouldPromptVisibleSessionNow(mode, text) &&
      isVisibleExtensionCommand(mode, text),
  );
}

async function promptVisibleSessionNow(
  mode: AnyRecord,
  text: string,
  options: AnyRecord = {},
) {
  if (options.flushPendingBash !== false)
    mode.flushPendingBashComponents?.();

  if (options.addHistory !== false) mode.editor?.addToHistory?.(text);
  mode.editor?.setText?.("");
  await mode.session.prompt(text);
  mode.updatePendingMessagesDisplay?.();
  mode.ui?.requestRender?.();
}

function isVisibleExtensionCommand(mode: AnyRecord, text: string) {
  if (!text.startsWith("/")) return false;
  if (typeof mode.isExtensionCommand === "function") {
    try {
      return mode.isExtensionCommand(text) === true;
    } catch {
      return false;
    }
  }

  const commandName = text.slice(1).split(/\s/, 1)[0];
  const extensionRunner = mode.session?.extensionRunner as AnyRecord | undefined;
  const getCommand = extensionRunner?.getCommand;

  return Boolean(
    typeof getCommand === "function" &&
      getCommand.call(extensionRunner, commandName),
  );
}

function hasOtherStreamingRuntime(session: AnyRecord) {
  const visibleSessionId = session.sessionManager?.getSessionId?.();

  return Boolean(
    visibleSessionId &&
      listRuntimeSessions().some(
        (runtime) =>
          runtime.session?.isStreaming === true &&
          runtime.session.sessionManager?.getSessionId?.() !== visibleSessionId,
      ),
  );
}

function removeSubmittedPendingInput(
  mode: AnyRecord,
  submitted: string,
  originalLength: number,
) {
  if (!Array.isArray(mode.pendingUserInputs)) return;
  const appended = mode.pendingUserInputs.slice(originalLength);
  if (appended.length === 1 && sameSubmittedText(appended[0], submitted))
    mode.pendingUserInputs.splice(originalLength, 1);
}

function editorText(editor: AnyRecord) {
  try {
    return typeof editor?.getText === "function" ? editor.getText() : undefined;
  } catch {
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
  if (
    state.liveHydrationBridgeInstalled ||
    !InteractiveMode?.prototype?.renderCurrentSessionState
  )
    return;
  state.liveHydrationBridgeInstalled = true;
  state.hostRenderCurrentSessionState = InteractiveMode.prototype
    .renderCurrentSessionState as LiveRuntimeState["hostRenderCurrentSessionState"];
  InteractiveMode.prototype.renderCurrentSessionState =
    function renderCurrentSessionStateWithLiveHydration(...args) {
      if (renderVisibleLiveSessionState(this)) return;

      const result = state.hostRenderCurrentSessionState?.apply(this, args);
      replayCurrentStreamingMessage(this);

      return result;
    };
}

export function renderVisibleLiveSessionState(mode: AnyRecord) {
  const session = mode?.session;
  const liveMessages = liveAgentMessages(session);

  if (
    session?.isStreaming !== true ||
    liveMessages.length === 0 ||
    typeof mode.renderSessionContext !== "function"
  )
    return false;

  resetVisibleSessionState(mode);
  const sessionContext = safeSessionContext(session.sessionManager);
  const persistedMessages = Array.isArray(sessionContext.messages)
    ? sessionContext.messages
    : [];
  const hydration = reconcileVisibleSessionMessages(
    persistedMessages,
    liveMessages,
  );

  mode.renderSessionContext(
    { ...sessionContext, messages: hydration.renderedMessages },
    { updateFooter: true, populateHistory: true },
  );

  for (const message of hydration.liveOnlyMessages)
    replayLiveOnlyMessage(mode, message);

  for (const toolCall of unresolvedToolCalls(liveMessages))
    replayToolExecutionStart(mode, toolCall);

  return true;
}

function reconcileVisibleSessionMessages(
  persistedMessages: AnyRecord[],
  liveMessages: AnyRecord[],
) {
  const renderedMessages: AnyRecord[] = [];
  let liveIndex = 0;

  for (const persistedMessage of persistedMessages) {
    const liveMessage = liveMessages[liveIndex];

    if (
      liveMessage &&
      messageSignature(persistedMessage) === messageSignature(liveMessage)
    ) {
      renderedMessages.push(persistedMessage);
      liveIndex += 1;
      continue;
    }

    if (isPersistedUiMessage(persistedMessage))
      renderedMessages.push(persistedMessage);
  }

  return {
    renderedMessages,
    liveOnlyMessages: liveMessages.slice(liveIndex),
  };
}

function isPersistedUiMessage(message: AnyRecord) {
  return message?.role === "custom";
}

function resetVisibleSessionState(mode: AnyRecord) {
  mode.chatContainer?.clear?.();
  mode.pendingMessagesContainer?.clear?.();
  mode.compactionQueuedMessages = [];
  mode.streamingComponent = undefined;
  mode.streamingMessage = undefined;
  mode.pendingTools?.clear?.();
}

function replayLiveOnlyMessage(mode: AnyRecord, message: AnyRecord) {
  if (typeof mode.handleEvent !== "function") return;

  if (message?.role === "assistant") {
    replayStreamingMessage(mode, message);
    return;
  }

  void mode.handleEvent({ type: "message_start", message });
}

function replayCurrentStreamingMessage(mode: AnyRecord) {
  const session = mode?.session;
  const agentState = session?.state ?? session?.agent?.state;
  const streamingMessage = agentState?.streamingMessage;

  if (
    session?.isStreaming !== true ||
    streamingMessage?.role !== "assistant" ||
    typeof mode.handleEvent !== "function"
  )
    return false;

  replayStreamingMessage(mode, streamingMessage);
  return true;
}

function replayStreamingMessage(mode: AnyRecord, message: AnyRecord) {
  void mode.handleEvent({ type: "message_start", message });
  void mode.handleEvent({ type: "message_update", message });
}

function replayToolExecutionStart(mode: AnyRecord, toolCall: AnyRecord) {
  if (typeof mode.handleEvent !== "function") return;
  void mode.handleEvent({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments ?? {},
  });
}

function liveAgentMessages(session: AnyRecord) {
  const agentState = session?.state ?? session?.agent?.state;
  const messages = Array.isArray(agentState?.messages)
    ? agentState.messages
    : [];
  const streamingMessage = agentState?.streamingMessage;

  return streamingMessage && !messages.includes(streamingMessage)
    ? [...messages, streamingMessage]
    : messages;
}

function safeSessionContext(sessionManager: AnyRecord) {
  try {
    const context = sessionManager?.buildSessionContext?.();

    return context && typeof context === "object" ? context : { messages: [] };
  } catch {
    return { messages: [] };
  }
}

function messageSignature(message: AnyRecord) {
  if (!message || typeof message !== "object") return "";

  return JSON.stringify({
    role: message.role,
    customType: message.customType,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    text: messageText(message),
    toolCalls: messageToolCalls(message).map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
    })),
  });
}

function messageText(message: AnyRecord) {
  const content = message?.content;

  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function messageToolCalls(message: AnyRecord) {
  const content = message?.content;

  if (!Array.isArray(content)) return [];

  return content.filter((part) => part?.type === "toolCall" && part.id);
}

function unresolvedToolCalls(messages: AnyRecord[]) {
  const unresolved = new Map<string, AnyRecord>();

  for (const message of messages) {
    if (message?.role === "assistant")
      for (const toolCall of messageToolCalls(message))
        unresolved.set(toolCall.id, toolCall);

    if (message?.role === "toolResult" && message.toolCallId)
      unresolved.delete(message.toolCallId);
  }

  return [...unresolved.values()];
}

export function livePath(sessionId) {
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
  const {
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
  } = await loadPiCodingAgentPeer();
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

export function getRuntimeSession(sessionId: string) {
  return getLiveRuntimeState().runtimeSessions.get(sessionId);
}

export function findRuntimeSession(predicate: (runtime: PiRuntimeSession) => boolean) {
  return [...getLiveRuntimeState().runtimeSessions.values()].find(predicate);
}

export function setRuntimeSession(sessionId: string, runtime: PiRuntimeSession) {
  const runtimeSessions = getLiveRuntimeState().runtimeSessions;
  const existing = runtimeSessions.get(sessionId);
  const next = existing ?? runtime;

  Object.assign(next, runtime, { lastSeenAt: Date.now() });
  runtimeSessions.set(sessionId, next);
  pruneRuntimeSessions();

  return next;
}

export function updateRuntimeSession(sessionId: string, patch: Partial<PiRuntimeSession>) {
  const existing = getLiveRuntimeState().runtimeSessions.get(sessionId);

  if (!existing) return undefined;

  return setRuntimeSession(sessionId, { ...existing, ...patch });
}

export function listRuntimeSessions() {
  return [...getLiveRuntimeState().runtimeSessions.values()];
}

export function deleteRuntimeSession(sessionId: string) {
  getLiveRuntimeState().runtimeSessions.delete(sessionId);
}

export function pruneRuntimeSessions({
  maxEntries = 100,
  maxIdleMs = 12 * 60 * 60_000,
} = {}) {
  const now = Date.now();
  const runtimeSessions = getLiveRuntimeState().runtimeSessions;

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
