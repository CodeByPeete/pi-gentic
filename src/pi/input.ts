import { getActiveState } from "../agents/activation.js";
import { recoverDiagnostic, reportRuntimeDiagnostic } from "../shared/diagnostics.js";
import { isRecord } from "../shared/values.js";
import type { HostRecord, PiAgentSession, SessionTransition, SessionTransitionSubmission } from "./types.js";
import { abortAgentCallsForSession, hasCancellableAgentCallsForSession } from "../delegation/runs.js";
import {
  deleteRuntimeSession,
  getRuntimeSession,
  listRuntimeSessions,
  runtimeSessionIsRunning,
  setRuntimeSession,
  unregisterLiveRuntime,
} from "./sessions.js";
import type { PiCodingAgentPeer } from "./runtime.js";
import { callHostMethod, captureHostMethod, type LiveRuntimeState } from "./runtime.js";

const NATIVE_INTERACTIVE_SUBMIT = Symbol.for("pi-gentic.native-interactive-submit");

export function installSessionLifecycle(state: LiveRuntimeState, peer: PiCodingAgentPeer) {
  installSessionBinding(state, peer);
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

function installSessionBinding(state: LiveRuntimeState, { AgentSession }: Pick<PiCodingAgentPeer, "AgentSession">) {
  if (!captureHostMethod(state, "session.bindExtensions", AgentSession.prototype.bindExtensions)) return;

  AgentSession.prototype.bindExtensions = async function bindExtensionsWithSessionTracking(...args: unknown[]) {
    state.hostSessions.set(this.sessionManager, this);

    return callHostMethod(state, "session.bindExtensions", this, args);
  };
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
      state.hostSessions.delete(this.sessionManager);
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

type SessionTransitionRegistry = {
  readonly sessionTransitions: WeakMap<object, SessionTransition>;
  readonly transitionDispatches: WeakMap<object, SessionTransition>;
};

/** Coordinates input with one host-owned session replacement. */
export async function trackSessionTransition<T>(
  registry: SessionTransitionRegistry,
  runtimeHost: object,
  destination: string,
  run: (transition: SessionTransition) => Promise<T>,
) {
  const active = registry.sessionTransitions.get(runtimeHost);

  if (active?.phase === "opening")
    throw new Error(`A session change to the ${active.destination} is already in progress.`);
  const transition: SessionTransition = {
    destination,
    submissions: [],
    previews: new Map(),
    phase: "opening",
  };
  const enclosingDispatch = registry.transitionDispatches.get(runtimeHost);

  registry.sessionTransitions.set(runtimeHost, transition);
  if (enclosingDispatch?.submissions.length) {
    transition.submissions.push(...enclosingDispatch.submissions.splice(0));
    renderTransitionSubmissions(transition);
  }

  try {
    const result = await run(transition);

    if (isRecord(result) && result.cancelled === true) {
      transition.phase = "cancelled";
      restoreTransitionSubmissions(transition);
    } else {
      markSessionTransitionReady(registry, runtimeHost, transition);
      await drainTransitionSubmissions(registry, transition);
    }

    return result;
  } catch (error) {
    if (transition.phase === "opening") {
      transition.phase = "failed";
      restoreTransitionSubmissions(transition);
    }
    throw error;
  } finally {
    if (registry.sessionTransitions.get(runtimeHost) === transition) registry.sessionTransitions.delete(runtimeHost);
  }
}

function pendingSessionTransition(registry: SessionTransitionRegistry, runtimeHost: unknown) {
  if ((typeof runtimeHost !== "object" && typeof runtimeHost !== "function") || runtimeHost === null) return undefined;
  const transition = registry.sessionTransitions.get(runtimeHost);

  return transition?.phase === "opening" ? transition : undefined;
}

export function markSessionTransitionReady(
  registry: SessionTransitionRegistry,
  runtimeHost: object,
  transition: SessionTransition,
) {
  if (transition.phase !== "opening") return;
  transition.phase = "ready";
  if (registry.sessionTransitions.get(runtimeHost) === transition) registry.sessionTransitions.delete(runtimeHost);
}

function enqueueTransitionSubmission(transition: SessionTransition, submission: SessionTransitionSubmission) {
  transition.submissions.push(submission);
  submission.mode.editor?.setText?.("");
  renderTransitionSubmissions(transition);
}

function renderTransitionSubmissions(transition: SessionTransition, selectedMode?: HostRecord) {
  const modes = new Set([
    ...transition.previews.keys(),
    ...transition.submissions.map(({ mode }) => mode),
    ...(selectedMode ? [selectedMode] : []),
  ]);

  for (const mode of modes) {
    const submissions = transition.submissions.filter((submission) => submission.mode === mode);

    if (submissions.length === 0) {
      clearTransitionPreview(transition, mode);
      continue;
    }
    const count = submissions.length;
    const noun = count === 1 ? "message" : "messages";
    const preview = submissions.map(({ text }) => text.trim()).join("\n");

    mode.showStatus?.(`${count} ${noun} queued for ${transition.destination}:\n${preview}`);
    transition.previews.set(mode, {
      spacer: mode.lastStatusSpacer,
      text: mode.lastStatusText,
    });
    mode.ui?.requestRender?.();
  }
}

function restoreTransitionSubmissions(
  transition: SessionTransition,
  selectedMode?: HostRecord,
  status = "after the session change did not complete",
) {
  const submissions = transition.submissions.filter(({ mode }) => !selectedMode || mode === selectedMode);

  transition.submissions.splice(
    0,
    transition.submissions.length,
    ...transition.submissions.filter(({ mode }) => selectedMode && mode !== selectedMode),
  );
  const modes = new Set(submissions.map(({ mode }) => mode));

  for (const mode of modes) {
    clearTransitionPreview(transition, mode);
    const queuedText = submissions
      .filter((submission) => submission.mode === mode)
      .map(({ text }) => text.trim())
      .filter(Boolean)
      .join("\n\n");
    const currentText = String(readEditorText(mode.editor) ?? "").trim();
    const restored = [queuedText, currentText].filter(Boolean).join("\n\n");
    const count = submissions.filter((submission) => submission.mode === mode).length;
    const noun = count === 1 ? "message" : "messages";

    mode.editor?.setText?.(restored);
    mode.showStatus?.(`Restored ${count} queued ${noun} ${status}.`);
    mode.ui?.requestRender?.();
  }
}

export function drainTransitionSubmissions(registry: SessionTransitionRegistry, transition: SessionTransition) {
  transition.drain ??= (async () => {
    while (transition.submissions.length > 0) {
      const submission = transition.submissions.shift();

      if (!submission) continue;
      renderTransitionSubmissions(transition, submission.mode);
      const runtimeHost = submission.mode.runtimeHost;

      if (runtimeHost && (typeof runtimeHost === "object" || typeof runtimeHost === "function"))
        registry.transitionDispatches.set(runtimeHost, transition);
      try {
        await submission.deliver();
      } catch (error) {
        transition.submissions.unshift(submission);
        transition.phase = "failed";
        restoreTransitionSubmissions(transition, undefined, "after queued delivery failed");
        reportRuntimeDiagnostic("session-transition-submission", error);
        break;
      } finally {
        if (runtimeHost && registry.transitionDispatches.get(runtimeHost) === transition)
          registry.transitionDispatches.delete(runtimeHost);
      }
    }
  })().finally(() => {
    transition.drain = undefined;
  });

  return transition.drain;
}

function clearTransitionPreview(transition: SessionTransition, mode: HostRecord) {
  const preview = transition.previews.get(mode);
  const children = mode.chatContainer?.children;

  if (preview && Array.isArray(children)) {
    for (const component of [preview.spacer, preview.text]) {
      const index = children.indexOf(component);
      if (index >= 0) children.splice(index, 1);
    }
  }
  if (mode.lastStatusSpacer === preview?.spacer) mode.lastStatusSpacer = undefined;
  if (mode.lastStatusText === preview?.text) mode.lastStatusText = undefined;
  transition.previews.delete(mode);
  mode.ui?.requestRender?.();
}

function readEditorText(editor: HostRecord) {
  return recoverDiagnostic(
    "pi-host-editor-text",
    () => editor?.getText?.(),
    () => undefined,
  );
}
