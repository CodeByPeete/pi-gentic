import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Duration, Effect, Fiber, FileSystem, Schedule, Stream } from "effect";
import { formatDuration, shortestUniqueSessionId, shortSessionId } from "../../../shared/value.js";
import type { PiTheme } from "../types.js";
import type { ExtensionRuntime } from "../../../runtime/ExtensionRuntime.js";
import { enrichSessionSummary, summarizeSession, treeSwitchPath } from "../../../application/sessions/model.js";
import { withRuntimeState } from "../../../application/sessions/runtime-view.js";
import { styleAgentName, timer } from "../../../interface/presentation/text.js";
import { listRuntimeSessions, livePath, runtimeSessionIsRunning } from "../sessions/live.js";
import { recordHostDiagnostic, type HostRecord } from "../state.js";
import { reconcileSessionMembership, sameSessionMembership } from "./cache.js";

const ORIGINAL_SESSION = Symbol("pi-gentic.original-session");
const SESSION_PRESENTATION = Symbol("pi-gentic.session-presentation");
const REFRESH_INTERVAL_MS = 1000;
const resumeRefreshers = new Set<(sessions?: HostRecord[]) => void>();

type DecoratedSession = HostRecord & {
  [ORIGINAL_SESSION]?: HostRecord;
  [SESSION_PRESENTATION]?: HostRecord;
};

export function publishResumeSessionMetadata(sessions: HostRecord[]) {
  for (const refresh of resumeRefreshers) refresh(sessions);
}

export function openDecoratedResumeSelector(
  mode: HostRecord,
  nativeShowSessionSelector: (this: HostRecord, ...args: unknown[]) => unknown,
  args: unknown[],
  theme: PiTheme,
  runtime: ExtensionRuntime,
  membershipChanges: Stream.Stream<HostRecord[], never, FileSystem.FileSystem>,
) {
  const nativeShowSelector = mode.showSelector;

  if (typeof nativeShowSelector !== "function") return nativeShowSessionSelector.apply(mode, args);

  mode.showSelector = function showDecoratedSelector(create: (done: () => void) => HostRecord) {
    return nativeShowSelector.call(this, (done: () => void) => {
      let dispose = () => {};
      const result = create(() => {
        dispose();
        done();
      });

      try {
        dispose = decorateResumeSelector(
          result?.component,
          () => mode.ui?.requestRender?.(),
          theme,
          runtime,
          membershipChanges,
        );
      } catch (error) {
        recordHostDiagnostic(error);
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
  component: HostRecord,
  requestRender = () => {},
  theme?: PiTheme,
  runtime?: ExtensionRuntime,
  membershipChanges?: Stream.Stream<HostRecord[], never, FileSystem.FileSystem>,
) {
  const list = component?.getSessionList?.();

  assertDecoratableSessionList(list);
  if (!isCompatibleTheme(theme)) throw new Error("Pi resume integration unavailable: active theme is inaccessible.");
  const nativeSetSessions = list.setSessions.bind(list);
  const nativeFilterSessions = list.filterSessions.bind(list);
  const nativeRender = list.render.bind(list);
  const nativeOnSelect = list.onSelect;
  const header = component.header;
  const nativeHeaderRender = typeof header?.render === "function" ? header.render.bind(header) : undefined;
  const nativeDispose = component.dispose?.bind(component);
  let refreshFiber: Fiber.Fiber<unknown, never> | undefined;
  let membershipFiber: Fiber.Fiber<unknown, never> | undefined;
  let disposed = false;

  const refreshSessions = () => {
    for (const session of list.allSessions ?? []) refreshDecoratedSession(session);
  };
  const refreshVisibleSessions = () => {
    for (const { session } of visibleSessionRange(list).nodes) refreshDecoratedSession(session);
  };
  const refresh = (hydrated: HostRecord[] = []) => {
    if (hydrated.length > 0) {
      const property = component.scope === "all" ? "allSessions" : "currentSessions";
      const current = (component[property] ?? list.allSessions ?? []).map(originalSession);
      const byPath = new Map(hydrated.map((session) => [session.path, session]));
      const sessions = current.map((session: HostRecord) => {
        const metadata = byPath.get(session.path);
        return metadata ? { ...session, ...metadata, metadataPending: false } : session;
      });

      if (sessions.some((session: HostRecord, index: number) => session !== current[index])) {
        component[property] = sessions;
        list.setSessions(sessions, component.scope === "all");
      }
    }
    refreshSessions();
    requestRender();
  };
  resumeRefreshers.add(refresh);
  if (runtime && membershipChanges) {
    membershipFiber = runtime.runFork(
      membershipChanges.pipe(
        Stream.runForEach((skeletons) =>
          Effect.sync(() => {
            const current = (component.currentSessions ?? list.allSessions ?? []).map(originalSession);

            if (current.length === 0 && component.currentLoading === true) return;
            const knownPaths = new Set(current.map((session: HostRecord) => session.path));
            const membership =
              knownPaths.size === 0
                ? skeletons
                : skeletons.map((session) =>
                    knownPaths.has(session.path)
                      ? session
                      : { ...enrichSessionSummary(session), metadataPending: false },
                  );
            const sessions = reconcileSessionMembership(current, membership);

            if (sameSessionMembership(current, sessions)) return;
            component.currentSessions = sessions;
            list.setSessions(sessions, false);
            requestRender();
          }),
        ),
      ),
    );
  }
  const syncRefreshTimer = () => {
    const running = listRuntimeSessions().some(runtimeSessionIsRunning);

    if (running && !refreshFiber && runtime) {
      refreshFiber = runtime.runFork(
        Effect.sync(() => {
          refreshVisibleSessions();
          requestRender();
        }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(REFRESH_INTERVAL_MS)))),
      );
    } else if (!running && refreshFiber) {
      runtime?.runFork(Fiber.interrupt(refreshFiber));
      refreshFiber = undefined;
    }
  };

  list.setSessions = (sessions: HostRecord[], showCwd: boolean) => {
    const result = nativeSetSessions(decorateSessions(sessions ?? []), showCwd);
    syncRefreshTimer();
    return result;
  };
  list.render = (width: number) => {
    refreshVisibleSessions();
    syncRefreshTimer();

    return renderDecoratedRows(list, nativeRender(width), width, theme);
  };
  if (nativeHeaderRender)
    header.render = (width: number) => {
      const lines = nativeHeaderRender(width);
      const sessions = list.allSessions ?? [];
      const pending = sessions.filter((session: DecoratedSession) => originalSession(session)?.metadataPending).length;

      if (pending > 0 && header.loading !== true)
        lines[1] = theme.fg("accent", `Loading session details… ${sessions.length - pending}/${sessions.length}`);
      return lines;
    };
  list.onSelect = (sessionPath: string) => {
    const session = (list.allSessions ?? []).find(
      (candidate: DecoratedSession) => originalSession(candidate)?.path === sessionPath,
    );
    const presentation = sessionPresentation(session);
    return nativeOnSelect?.(treeSwitchPath({ ...presentation, path: sessionPath }));
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (refreshFiber) runtime?.runFork(Fiber.interrupt(refreshFiber));
    if (membershipFiber) runtime?.runFork(Fiber.interrupt(membershipFiber));
    refreshFiber = undefined;
    membershipFiber = undefined;
    resumeRefreshers.delete(refresh);
    list.setSessions = nativeSetSessions;
    list.filterSessions = nativeFilterSessions;
    list.render = nativeRender;
    list.onSelect = nativeOnSelect;
    if (nativeHeaderRender) header.render = nativeHeaderRender;
    component.dispose = nativeDispose;
    nativeDispose?.();
  };

  component.dispose = dispose;
  return dispose;
}

function assertDecoratableSessionList(list: HostRecord) {
  const required = ["setSessions", "filterSessions", "render"].filter((method) => typeof list?.[method] !== "function");

  if (required.length > 0 || !Array.isArray(list?.allSessions) || !Array.isArray(list?.filteredSessions))
    throw new Error(
      `Pi resume integration unavailable: unsupported native session list${
        required.length ? ` (${required.join(", ")})` : ""
      }.`,
    );
}

function decorateSessions(sessions: HostRecord[]) {
  const ids = sessions.map((session) => session.id ?? session.sessionId);
  const pathsById = new Map(sessions.map((session, index) => [ids[index], session.path]));
  const shortIds = ids.map(shortSessionId);
  const shortIdCounts = new Map<string, number>();

  for (const shortId of shortIds) shortIdCounts.set(shortId, (shortIdCounts.get(shortId) ?? 0) + 1);
  const enrichImmediately = sessions.length <= 50;

  return sessions.map((session, index) => {
    const persisted = enrichImmediately ? enrichSessionSummary(session) : summarizeSession(session);
    const sessionId = ids[index];
    const shortId = shortIds[index] ?? shortSessionId(sessionId);
    const parent = session.parentSessionPath ?? session.parentSessionId;
    const clone: DecoratedSession = {
      ...session,
      parentSessionPath: pathsById.get(parent) ?? session.parentSessionPath,
    };

    Object.defineProperties(clone, {
      [ORIGINAL_SESSION]: { value: session },
      [SESSION_PRESENTATION]: {
        configurable: true,
        writable: true,
        value: {
          agentName: persisted.agentName,
          lastMessage: persisted.lastMessage,
          sessionId,
          shortId: shortIdCounts.get(shortId) === 1 ? shortId : shortestUniqueSessionId(sessionId, ids),
        },
      },
    });
    refreshDecoratedSession(clone, persisted);
    return clone;
  });
}

function refreshDecoratedSession(session: DecoratedSession, persisted?: HostRecord) {
  const original = originalSession(session);
  const previous = sessionPresentation(session);

  if (!original || !previous) return;
  persisted ??= summarizeSession(original);
  Object.assign(original, {
    agentName: persisted.agentName,
    firstMessage: persisted.firstMessage,
    lastMessage: persisted.lastMessage,
  });
  const live = withRuntimeState({
    ...original,
    sessionId: previous.sessionId,
    agentName: persisted.agentName ?? previous.agentName,
  });
  const loading = original.metadataPending === true;
  const presentation: HostRecord = {
    ...previous,
    agentName: live.agentName ?? persisted.agentName ?? previous.agentName,
    lastMessage: persisted.lastMessage ?? previous.lastMessage,
    running: live.running === true,
    livePath: live.running ? livePath(previous.sessionId) : undefined,
    inactiveMs: Number(live.inactiveMs ?? 0),
    loading,
  };
  const title = loading ? "Loading session details…" : (original.name ?? original.firstMessage ?? "(no messages)");
  const lastMessage = presentation.lastMessage;
  const messageTitle = loading
    ? title
    : !lastMessage || lastMessage === title
      ? title
      : original.name
        ? `${title} · Latest: ${lastMessage}`
        : `${lastMessage} · Started: ${title}`;
  const search = [
    original.allMessagesText,
    presentation.agentName,
    presentation.sessionId,
    presentation.shortId,
    presentation.running ? "running" : "stopped",
  ]
    .filter(Boolean)
    .join(" ");

  session[SESSION_PRESENTATION] = {
    ...presentation,
    messageTitle,
  };
  session.allMessagesText = search;
}

function visibleSessionRange(list: HostRecord) {
  const filtered = list.filteredSessions ?? [];
  const maxVisible = Math.max(1, Number(list.maxVisible ?? 10));
  const selectedIndex = Math.min(Math.max(0, Number(list.selectedIndex ?? 0)), Math.max(0, filtered.length - 1));
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));

  return {
    start,
    nodes: filtered.slice(start, Math.min(start + maxVisible, filtered.length)),
  };
}

function renderDecoratedRows(list: HostRecord, lines: string[], width: number, theme: PiTheme) {
  const { nodes: visible, start } = visibleSessionRange(list);
  const searchLineCount = list.searchInput?.render?.(width)?.length ?? 1;
  const rowOffset = searchLineCount + 1;
  const result = [...lines];

  visible.forEach((node: HostRecord, index: number) => {
    const lineIndex = rowOffset + index;

    if (sessionPresentation(node?.session) && typeof result[lineIndex] === "string")
      result[lineIndex] = renderDecoratedRow(list, node, start + index, width, theme);
  });

  return result;
}

function renderDecoratedRow(list: HostRecord, node: HostRecord, index: number, width: number, theme: PiTheme) {
  const session = node.session;
  const original = originalSession(session) ?? session;
  const presentation = sessionPresentation(session)!;
  const isSelected = index === Number(list.selectedIndex ?? 0);
  const isConfirmingDelete = original.path === list.confirmingDeletePath;
  const isCurrent = list.isCurrentSessionPath?.(original.path) === true;
  const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
  const prefix = theme.fg("dim", treePrefix(node));
  const status = theme.fg(presentation.running ? "success" : "dim", presentation.running ? "●" : "○");
  const agent = presentation.agentName
    ? `${theme.bold(styleAgentName(presentation.agentName, { bracketed: true }))} `
    : "";
  const left = `${cursor}${prefix}${status} ${agent}`;
  const id = presentation.shortId ? ` ${theme.fg("dim", `(${presentation.shortId})`)}` : "";
  const timerText = formatDuration(presentation.inactiveMs);
  const inactive = presentation.running
    ? ` ${theme.fg("dim", "Inactive:")} ${timer(timerText)}${" ".repeat(Math.max(0, 8 - timerText.length))}`
    : "";
  const orchestrationMetadata = `${id}${inactive}`;
  const nativeMetadataWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(orchestrationMetadata) - 12);
  const nativeMetadata = presentation.loading
    ? ""
    : truncateToWidth(nativeSessionMetadata(list, original), nativeMetadataWidth, "…");
  const right = `${theme.fg("dim", nativeMetadata)}${orchestrationMetadata}`;
  const messageColor = isConfirmingDelete ? "error" : isCurrent ? "accent" : undefined;
  const available = Math.max(0, width - visibleWidth(left) - visibleWidth(right) - 2);
  const message = truncateToWidth(
    String(presentation.messageTitle ?? "(no messages)")
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .trim(),
    available,
    "…",
  );
  let styledMessage = messageColor ? theme.fg(messageColor, message) : message;

  if (isSelected) styledMessage = theme.bold(styledMessage);
  const spacing = " ".repeat(
    Math.max(1, width - visibleWidth(left) - visibleWidth(styledMessage) - visibleWidth(right)),
  );
  let line = truncateToWidth(`${left}${styledMessage}${spacing}${right}`, width);

  if (isSelected) line = theme.bg("selectedBg", line);
  return line;
}

function nativeSessionMetadata(list: HostRecord, session: HostRecord) {
  const parts: string[] = [];

  if (list.showCwd && session.cwd) parts.push(shortenPath(session.cwd));
  if (list.showPath && session.path) parts.push(shortenPath(session.path));
  parts.push(String(session.messageCount), formatSessionDate(session.modified));
  return parts.join(" ");
}

function treePrefix(node: HostRecord) {
  if (Number(node.depth ?? 0) === 0) return "";
  const ancestors = Array.isArray(node.ancestorContinues)
    ? node.ancestorContinues.map((continues) => (continues ? "│  " : "   ")).join("")
    : "";
  return `${ancestors}${node.isLast ? "└─ " : "├─ "}`;
}

function shortenPath(value: string) {
  const home = homedir();

  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function formatSessionDate(value: Date) {
  const ageMs = Date.now() - value.getTime();
  const minutes = Math.floor(ageMs / 60_000);
  const hours = Math.floor(ageMs / 3_600_000);
  const days = Math.floor(ageMs / 86_400_000);

  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function isCompatibleTheme(theme: PiTheme | undefined): theme is PiTheme {
  return typeof theme?.fg === "function" && typeof theme?.bg === "function" && typeof theme?.bold === "function";
}

function originalSession(session: DecoratedSession | undefined) {
  return session?.[ORIGINAL_SESSION] ?? session;
}

function sessionPresentation(session: DecoratedSession | undefined): HostRecord | undefined {
  return session?.[SESSION_PRESENTATION];
}
