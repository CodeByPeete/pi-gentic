import { isRecord } from "../../../shared/value.js";
import { recoverDiagnostic, reportRuntimeDiagnostic } from "../../../shared/diagnostics.js";
import type { HostRecord } from "../state.js";

type SessionTransitionSubmission = {
  readonly text: string;
  readonly mode: HostRecord;
  readonly deliver: () => Promise<unknown>;
};

export type SessionTransition = {
  readonly destination: string;
  readonly submissions: SessionTransitionSubmission[];
  readonly previews: Map<HostRecord, { readonly spacer?: unknown; readonly text?: unknown }>;
  phase: "opening" | "ready" | "cancelled" | "failed";
  drain?: Promise<void>;
};

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

export function pendingSessionTransition(registry: SessionTransitionRegistry, runtimeHost: unknown) {
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

export function enqueueTransitionSubmission(transition: SessionTransition, submission: SessionTransitionSubmission) {
  transition.submissions.push(submission);
  submission.mode.editor?.setText?.("");
  renderTransitionSubmissions(transition);
}

export function renderTransitionSubmissions(transition: SessionTransition, selectedMode?: HostRecord) {
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

export function restoreTransitionSubmissions(
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

export function readEditorText(editor: HostRecord) {
  return recoverDiagnostic(
    "pi-host-editor-text",
    () => editor?.getText?.(),
    () => undefined,
  );
}
