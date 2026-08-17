import { getActiveState } from "../../application/agents/state.js";
import { recoverDiagnostic } from "../../shared/diagnostics.js";
import type { PiAgentSession } from "./types.js";
import { abortAgentCallsForSession, hasCancellableAgentCallsForSession } from "./delegation.js";
import {
  deleteRuntimeSession,
  getRuntimeSession,
  listRuntimeSessions,
  runtimeSessionIsRunning,
  setRuntimeSession,
  unregisterLiveRuntime,
} from "./sessions/live.js";
import type { PiCodingAgentPeer } from "./peer.js";
import {
  enqueueTransitionSubmission,
  pendingSessionTransition,
  readEditorText,
  renderTransitionSubmissions,
  restoreTransitionSubmissions,
} from "./sessions/transitions.js";
import { callHostMethod, captureHostMethod, type HostRecord, type LiveRuntimeState } from "./state.js";

const NATIVE_INTERACTIVE_SUBMIT = Symbol.for("pi-gentic.native-interactive-submit");

export function installSessionLifecycle(state: LiveRuntimeState, peer: PiCodingAgentPeer) {
  installSessionAbort(state, peer);
  installSessionPrompt(state, peer);
  installSessionDispose(state, peer);
}

export function installInteractiveInput(state: LiveRuntimeState, peer: PiCodingAgentPeer) {
  installInteractiveEscape(state, peer);
  installInteractiveSubmit(state, peer);
  installInteractiveFollowUp(state, peer);
  installInteractiveLiveSessionHydration(state, peer);
}

function installSessionAbort(state: LiveRuntimeState, { AgentSession }: Pick<PiCodingAgentPeer, "AgentSession">) {
  if (!captureHostMethod(state, "session.abort", AgentSession.prototype.abort)) return;

  AgentSession.prototype.abort = async function abortWithPiGenticTargets(...args: unknown[]) {
    const sessionId = this.sessionManager.getSessionId?.();

    await abortAgentCallsForSession(sessionId, {
      actor: "aborted session",
      skipSessionAbort: sessionId,
    });

    return callHostMethod(state, "session.abort", this, args);
  };
}

function installSessionPrompt(state: LiveRuntimeState, { AgentSession }: Pick<PiCodingAgentPeer, "AgentSession">) {
  if (!captureHostMethod(state, "session.prompt", AgentSession.prototype.prompt)) return;

  AgentSession.prototype.prompt = async function promptWithPiGenticRuntime(...args: unknown[]) {
    return trackSessionPrompt(this, () => callHostMethod(state, "session.prompt", this, args), args[0]);
  };
}

function installSessionDispose(state: LiveRuntimeState, { AgentSession }: Pick<PiCodingAgentPeer, "AgentSession">) {
  if (!captureHostMethod(state, "session.dispose", AgentSession.prototype.dispose)) return;

  AgentSession.prototype.dispose = function disposeWithPiGenticRuntimeCleanup(...args: unknown[]) {
    const sessionId = this.sessionManager?.getSessionId?.();

    try {
      return callHostMethod(state, "session.dispose", this, args);
    } finally {
      if (typeof sessionId === "string" && sessionId) {
        unregisterLiveRuntime(sessionId);
        deleteRuntimeSession(sessionId);
      }
    }
  };
}

export async function trackSessionPrompt<T>(session: HostRecord, run: () => Promise<T> | T, prompt?: unknown) {
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

function installInteractiveSubmit(
  state: LiveRuntimeState,
  { InteractiveMode }: Pick<PiCodingAgentPeer, "InteractiveMode">,
) {
  if (
    !captureHostMethod(
      state,
      "interactive.setupEditorSubmitHandler",
      InteractiveMode.prototype.setupEditorSubmitHandler,
    )
  )
    return;
  InteractiveMode.prototype.setupEditorSubmitHandler = function setupEditorSubmitHandlerWithPiGenticCommands(
    ...args: unknown[]
  ) {
    const result = callHostMethod(state, "interactive.setupEditorSubmitHandler", this, args);
    const nativeSubmit = this.defaultEditor?.onSubmit;

    if (typeof nativeSubmit !== "function") return result;
    Reflect.set(this, NATIVE_INTERACTIVE_SUBMIT, nativeSubmit);
    this.defaultEditor.onSubmit = (text: unknown) => submitInteractiveInput(state, this, nativeSubmit, text);

    return result;
  };
}

async function submitInteractiveInput(
  state: LiveRuntimeState,
  mode: HostRecord,
  nativeSubmit: (text: unknown) => unknown,
  text: unknown,
) {
  const command = String(text ?? "").trim();
  const transition = pendingSessionTransition(state, mode.runtimeHost);

  if (transition && command) {
    enqueueTransitionSubmission(transition, {
      text: String(text ?? ""),
      mode,
      deliver: () => submitInteractiveInput(state, mode, nativeSubmit, text),
    });
    return;
  }

  if (shouldPromptVisibleSessionBeforeNative(mode, command)) {
    await promptVisibleSessionNow(mode, command, { addHistory: true });
    return;
  }

  const fallbackAfterNative = shouldPromptVisibleSessionAfterNative(mode, command);
  const submittedEditor = mode.editor;
  const submittedText = readEditorText(submittedEditor);
  const pendingInputs = Array.isArray(mode.pendingUserInputs) ? mode.pendingUserInputs : undefined;
  const pendingInputCount = pendingInputs?.length ?? 0;
  const addedPendingInputs = fallbackAfterNative && !pendingInputs;
  if (addedPendingInputs) mode.pendingUserInputs = [];
  const result = await nativeSubmit(text);

  if (
    fallbackAfterNative &&
    shouldPromptVisibleSessionNow(mode, command) &&
    mode.editor === submittedEditor &&
    sameSubmittedText(readEditorText(submittedEditor), command) &&
    sameSubmittedText(submittedText, command)
  ) {
    removeSubmittedPendingInput(mode, command, pendingInputCount);
    await promptVisibleSessionNow(mode, command, {
      addHistory: false,
      flushPendingBash: false,
    });
  }

  if (addedPendingInputs && mode.pendingUserInputs?.length === 0) delete mode.pendingUserInputs;

  return result;
}

function installInteractiveFollowUp(
  state: LiveRuntimeState,
  { InteractiveMode }: Pick<PiCodingAgentPeer, "InteractiveMode">,
) {
  if (!captureHostMethod(state, "interactive.handleFollowUp", InteractiveMode.prototype.handleFollowUp)) return;
  InteractiveMode.prototype.handleFollowUp = async function handleFollowUpWithSessionTransition() {
    const transition = pendingSessionTransition(state, this.runtimeHost);
    const text = String(this.editor?.getExpandedText?.() ?? readEditorText(this.editor) ?? "").trim();
    const nativeSubmit = Reflect.get(this, NATIVE_INTERACTIVE_SUBMIT);

    if (!transition || !text || typeof nativeSubmit !== "function")
      return callHostMethod(state, "interactive.handleFollowUp", this, []);
    return enqueueTransitionSubmission(transition, {
      text,
      mode: this,
      deliver: () => submitInteractiveFollowUp(state, this, nativeSubmit, text),
    });
  };
}

async function submitInteractiveFollowUp(
  state: LiveRuntimeState,
  mode: HostRecord,
  nativeSubmit: (text: unknown) => unknown,
  text: string,
) {
  const transition = pendingSessionTransition(state, mode.runtimeHost);

  if (transition) {
    enqueueTransitionSubmission(transition, {
      text,
      mode,
      deliver: () => submitInteractiveFollowUp(state, mode, nativeSubmit, text),
    });
    return;
  }
  if (mode.session?.isCompacting === true) {
    if (isVisibleExtensionCommand(mode, text)) {
      mode.editor?.addToHistory?.(text);
      await mode.session.prompt(text);
    } else {
      mode.queueCompactionMessage?.(text, "followUp");
    }
    return;
  }
  if (mode.session?.isStreaming === true) {
    mode.editor?.addToHistory?.(text);
    await mode.session.prompt(text, { streamingBehavior: "followUp" });
    mode.updatePendingMessagesDisplay?.();
    mode.ui?.requestRender?.();
    return;
  }

  await submitInteractiveInput(state, mode, nativeSubmit, text);
}

function shouldPromptVisibleSessionBeforeNative(mode: HostRecord, text: string) {
  if (!shouldPromptVisibleSessionNow(mode, text)) return false;

  return !text.startsWith("/") || isVisibleExtensionCommand(mode, text);
}

function shouldPromptVisibleSessionAfterNative(mode: HostRecord, text: string) {
  return Boolean(
    text.startsWith("/") && !isVisibleExtensionCommand(mode, text) && shouldPromptVisibleSessionNow(mode, text),
  );
}

export function shouldPromptVisibleSessionNow(mode: HostRecord, text: string) {
  const session = mode?.session as HostRecord | undefined;

  return Boolean(
    String(text ?? "").trim() &&
    session &&
    session.isStreaming !== true &&
    session.isCompacting !== true &&
    typeof mode.onInputCallback !== "function" &&
    hasOtherStreamingRuntime(session),
  );
}

async function promptVisibleSessionNow(mode: HostRecord, text: string, options: HostRecord = {}) {
  if (options.flushPendingBash !== false) mode.flushPendingBashComponents?.();

  if (options.addHistory !== false) mode.editor?.addToHistory?.(text);
  mode.editor?.setText?.("");
  await mode.session.prompt(text);
  mode.updatePendingMessagesDisplay?.();
  mode.ui?.requestRender?.();
}

function isVisibleExtensionCommand(mode: HostRecord, text: string) {
  if (!text.startsWith("/")) return false;
  if (typeof mode.isExtensionCommand === "function")
    return recoverDiagnostic(
      "pi-host-extension-command",
      () => mode.isExtensionCommand(text) === true,
      () => false,
    );

  const commandName = text.slice(1).split(/\s/, 1)[0];
  const extensionRunner = mode.session?.extensionRunner as HostRecord | undefined;
  const getCommand = extensionRunner?.getCommand;

  return Boolean(typeof getCommand === "function" && getCommand.call(extensionRunner, commandName));
}

function hasOtherStreamingRuntime(session: HostRecord) {
  const visibleSessionId = session.sessionManager?.getSessionId?.();

  return Boolean(
    visibleSessionId &&
    listRuntimeSessions().some(
      (runtime) =>
        runtimeSessionIsRunning(runtime) && runtime.session.sessionManager?.getSessionId?.() !== visibleSessionId,
    ),
  );
}

function removeSubmittedPendingInput(mode: HostRecord, submitted: string, originalLength: number) {
  if (!Array.isArray(mode.pendingUserInputs)) return;
  const appended = mode.pendingUserInputs.slice(originalLength);
  if (appended.length === 1 && sameSubmittedText(appended[0], submitted))
    mode.pendingUserInputs.splice(originalLength, 1);
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

function installInteractiveEscape(
  state: LiveRuntimeState,
  { InteractiveMode }: Pick<PiCodingAgentPeer, "InteractiveMode">,
) {
  if (!captureHostMethod(state, "interactive.setupKeyHandlers", InteractiveMode.prototype.setupKeyHandlers)) return;
  InteractiveMode.prototype.setupKeyHandlers = function setupKeyHandlersWithPiGenticAbort(...args: unknown[]) {
    const result = callHostMethod(state, "interactive.setupKeyHandlers", this, args);
    const nativeEscape = this.defaultEditor?.onEscape;

    if (typeof nativeEscape !== "function") return result;
    this.defaultEditor.onEscape = () => {
      const transition = pendingSessionTransition(state, this.runtimeHost);

      if (transition?.submissions.some(({ mode }) => mode === this)) {
        restoreTransitionSubmissions(transition, this, "after queued delivery was cancelled");
        return;
      }

      return handleInteractiveEscape({
        sessionId: this.session?.sessionManager?.getSessionId?.(),
        isStreaming: this.session?.isStreaming,
        nativeEscape,
      });
    };

    return result;
  };
}

function installInteractiveLiveSessionHydration(
  state: LiveRuntimeState,
  { InteractiveMode }: Pick<PiCodingAgentPeer, "InteractiveMode">,
) {
  if (
    !captureHostMethod(
      state,
      "interactive.renderCurrentSessionState",
      InteractiveMode.prototype.renderCurrentSessionState,
    )
  )
    return;
  InteractiveMode.prototype.renderCurrentSessionState = function renderCurrentSessionStateWithLiveHydration(
    ...args: unknown[]
  ) {
    const result = callHostMethod(state, "interactive.renderCurrentSessionState", this, args);
    replayCurrentStreamingMessage(this);
    const transition = pendingSessionTransition(state, this.runtimeHost);
    if (transition) renderTransitionSubmissions(transition);
    return result;
  };
}

function replayCurrentStreamingMessage(mode: HostRecord) {
  const session = mode?.session;
  const agentState = session?.state ?? session?.agent?.state;
  const streamingMessage = agentState?.streamingMessage;

  if (session?.isStreaming !== true || streamingMessage?.role !== "assistant" || typeof mode.handleEvent !== "function")
    return false;

  replayStreamingMessage(mode, streamingMessage);
  return true;
}

function replayStreamingMessage(mode: HostRecord, message: HostRecord) {
  void mode.handleEvent({ type: "message_start", message });
  void mode.handleEvent({ type: "message_update", message });
}
