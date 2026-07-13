import {
  formatDuration,
  shortestUniqueSessionId,
} from "./catalog.js";
import {
  getLiveRuntimeState,
  livePath,
  loadPiCodingAgentPeer,
} from "./pi-host.js";
import {
  enrichSessionSummary,
  withRuntimeState,
} from "./sessions.js";
import { styleAgentName } from "./ui.js";

const RESUME_BRIDGE_KEY = Symbol.for("pi-gentic.resume-bridge");
const ORIGINAL_SESSION = Symbol("pi-gentic.original-session");
const SESSION_PRESENTATION = Symbol("pi-gentic.session-presentation");
const REFRESH_INTERVAL_MS = 1000;

type ResumeBridgeState = {
  installed: boolean;
  originalShowSessionSelector?: (this: AnyRecord, ...args: unknown[]) => unknown;
};

type DecoratedSession = AnyRecord & {
  [ORIGINAL_SESSION]?: AnyRecord;
  [SESSION_PRESENTATION]?: AnyRecord;
};

export async function installResumeBridge() {
  const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
  const bridge = (globalState[RESUME_BRIDGE_KEY] ??= {
    installed: false,
  }) as ResumeBridgeState;

  if (bridge.installed) return;

  try {
    const peer = await loadPiCodingAgentPeer();
    const prototype = peer.InteractiveMode?.prototype;
    const nativeShowSessionSelector = prototype?.showSessionSelector;

    if (typeof nativeShowSessionSelector !== "function")
      throw new Error(
        "Pi resume integration unavailable: InteractiveMode.showSessionSelector is missing.",
      );

    bridge.installed = true;
    bridge.originalShowSessionSelector = nativeShowSessionSelector;
    const interactivePrototype = prototype as AnyRecord;
    interactivePrototype.showSessionSelector = function showSessionSelectorWithPiGentic(
      this: AnyRecord,
      ...args: unknown[]
    ) {
      return openDecoratedResumeSelector(
        this,
        bridge.originalShowSessionSelector!,
        args,
      );
    };
  } catch (error) {
    recordCompatibilityDiagnostic(error);
  }
}

function openDecoratedResumeSelector(
  mode: AnyRecord,
  nativeShowSessionSelector: (this: AnyRecord, ...args: unknown[]) => unknown,
  args: unknown[],
) {
  const nativeShowSelector = mode.showSelector;

  if (typeof nativeShowSelector !== "function")
    return nativeShowSessionSelector.apply(mode, args);

  mode.showSelector = function showDecoratedSelector(create) {
    return nativeShowSelector.call(this, (done) => {
      let dispose = () => {};
      const result = create(() => {
        dispose();
        done();
      });

      try {
        dispose = decorateResumeSelector(result?.component, () =>
          mode.ui?.requestRender?.(),
        );
      } catch (error) {
        recordCompatibilityDiagnostic(error);
      }

      return result;
    });
  };

  try {
    return nativeShowSessionSelector.apply(mode, args);
  } finally {
    mode.showSelector = nativeShowSelector;
  }
}

export function decorateResumeSelector(
  component: AnyRecord,
  requestRender = () => {},
) {
  const list = component?.getSessionList?.();

  assertDecoratableSessionList(list);
  const nativeSetSessions = list.setSessions.bind(list);
  const nativeFilterSessions = list.filterSessions.bind(list);
  const nativeRender = list.render.bind(list);
  const nativeOnSelect = list.onSelect;
  const nativeDispose = component.dispose?.bind(component);
  let refreshTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const refreshSessions = () => {
    for (const session of list.allSessions ?? []) refreshDecoratedSession(session);
  };
  const syncRefreshTimer = () => {
    const running = (list.allSessions ?? []).some(
      (session) => sessionPresentation(session)?.running === true,
    );

    if (running && !refreshTimer) {
      refreshTimer = setInterval(() => {
        refreshSessions();
        requestRender();
      }, REFRESH_INTERVAL_MS);
      refreshTimer.unref?.();
    } else if (!running && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  };

  list.setSessions = (sessions, showCwd) => {
    const decorated = decorateSessions(sessions ?? []);
    const result = nativeSetSessions(decorated, showCwd);

    syncRefreshTimer();
    return result;
  };
  list.filterSessions = (query) => {
    refreshSessions();
    return nativeFilterSessions(query);
  };
  list.render = (width) => {
    refreshSessions();
    syncRefreshTimer();

    return colorDecoratedRows(list, nativeRender(width), width);
  };
  list.onSelect = (sessionPath) => {
    const session = (list.allSessions ?? []).find(
      (candidate) => originalSession(candidate)?.path === sessionPath,
    );
    const presentation = sessionPresentation(session);
    const switchPath =
      presentation?.running && presentation.sessionId
        ? livePath(presentation.sessionId)
        : sessionPath;

    return nativeOnSelect?.(switchPath);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    list.setSessions = nativeSetSessions;
    list.filterSessions = nativeFilterSessions;
    list.render = nativeRender;
    list.onSelect = nativeOnSelect;
    component.dispose = nativeDispose;
    nativeDispose?.();
  };

  component.dispose = dispose;
  return dispose;
}

function assertDecoratableSessionList(list: AnyRecord) {
  const required = [
    "setSessions",
    "filterSessions",
    "render",
  ].filter((method) => typeof list?.[method] !== "function");

  if (
    required.length > 0 ||
    !Array.isArray(list?.allSessions) ||
    !Array.isArray(list?.filteredSessions)
  )
    throw new Error(
      `Pi resume integration unavailable: unsupported native session list${
        required.length ? ` (${required.join(", ")})` : ""
      }.`,
    );
}

function decorateSessions(sessions: AnyRecord[]) {
  const ids = sessions.map((session) => session.id ?? session.sessionId);

  return sessions.map((session) => {
    const persisted = enrichSessionSummary(session);
    const clone: DecoratedSession = { ...session };

    Object.defineProperties(clone, {
      [ORIGINAL_SESSION]: { value: session },
      [SESSION_PRESENTATION]: {
        configurable: true,
        writable: true,
        value: {
          agentName: persisted.agentName,
          lastMessage: persisted.lastMessage,
          sessionId: session.id ?? session.sessionId,
          shortId: shortestUniqueSessionId(
            session.id ?? session.sessionId,
            ids,
          ),
        },
      },
    });
    refreshDecoratedSession(clone);
    return clone;
  });
}

function refreshDecoratedSession(session: DecoratedSession) {
  const original = originalSession(session);
  const previous = sessionPresentation(session);

  if (!original || !previous) return;
  const live = withRuntimeState({
    ...original,
    sessionId: previous.sessionId,
    agentName: previous.agentName,
  });
  const presentation: AnyRecord = {
    ...previous,
    agentName: live.agentName ?? previous.agentName,
    running: live.running === true,
    inactiveMs: Number(live.inactiveMs ?? 0),
  };
  const title = original.name ?? original.firstMessage ?? "(no messages)";
  const lastMessage = presentation.lastMessage;
  const messageTitle =
    !lastMessage || lastMessage === title
      ? title
      : original.name
        ? `${title} · Latest: ${lastMessage}`
        : `${lastMessage} · Started: ${title}`;
  const status = presentation.running ? "●" : "○";
  const agent = presentation.agentName ? ` [${presentation.agentName}]` : "";
  const id = presentation.shortId ? ` (${presentation.shortId})` : "";
  const inactive = presentation.running
    ? ` Inactive: ${formatDuration(presentation.inactiveMs)}`
    : "";
  const decoratedTitle = `${status}${agent}${id}${inactive} ${messageTitle}`;
  const search = [
    original.allMessagesText,
    presentation.agentName,
    presentation.sessionId,
    presentation.shortId,
    presentation.running ? "running" : "stopped",
  ]
    .filter(Boolean)
    .join(" ");

  session[SESSION_PRESENTATION] = presentation;
  session.name = original.name ? decoratedTitle : undefined;
  session.firstMessage = decoratedTitle;
  session.allMessagesText = search;
}

function colorDecoratedRows(list: AnyRecord, lines: string[], width: number) {
  const filtered = list.filteredSessions ?? [];
  const maxVisible = Math.max(1, Number(list.maxVisible ?? 10));
  const selectedIndex = Math.min(
    Math.max(0, Number(list.selectedIndex ?? 0)),
    Math.max(0, filtered.length - 1),
  );
  const start = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      filtered.length - maxVisible,
    ),
  );
  const visible = filtered.slice(start, Math.min(start + maxVisible, filtered.length));
  const searchLineCount = list.searchInput?.render?.(width)?.length ?? 1;
  const rowOffset = searchLineCount + 1;
  const result = [...lines];

  visible.forEach((node, index) => {
    const presentation = sessionPresentation(node?.session);
    const lineIndex = rowOffset + index;

    if (!presentation || typeof result[lineIndex] !== "string") return;
    let line = result[lineIndex];

    if (presentation.agentName) {
      const badge = `[${presentation.agentName}]`;
      line = line.replace(
        badge,
        styleAgentName(presentation.agentName, { bracketed: true }),
      );
    }
    if (presentation.running)
      line = line.replace("●", "\x1b[32m●\x1b[39m");
    result[lineIndex] = line;
  });

  return result;
}

function originalSession(session: DecoratedSession | undefined) {
  return session?.[ORIGINAL_SESSION] ?? session;
}

function sessionPresentation(
  session: DecoratedSession | undefined,
): AnyRecord | undefined {
  return session?.[SESSION_PRESENTATION];
}

function recordCompatibilityDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics = getLiveRuntimeState().compatibilityDiagnostics;

  if (!diagnostics.includes(message)) diagnostics.push(message);
}
