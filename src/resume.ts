import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

type SessionFileSnapshot = Map<string, string>;

type SessionListCacheEntry = {
  sessions?: AnyRecord[];
  snapshot?: SessionFileSnapshot;
  promise?: Promise<AnyRecord[]>;
};

type ResumeBridgeState = {
  installed: boolean;
  sessionLists: Map<string, SessionListCacheEntry>;
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
    sessionLists: new Map(),
  }) as ResumeBridgeState;
  bridge.sessionLists ??= new Map();

  if (bridge.installed) return;

  try {
    const peer = await loadPiCodingAgentPeer();
    const prototype = peer.InteractiveMode?.prototype;
    const nativeShowSessionSelector = prototype?.showSessionSelector;

    if (typeof nativeShowSessionSelector !== "function")
      throw new Error(
        "Pi resume integration unavailable: InteractiveMode.showSessionSelector is missing.",
      );
    if (!peer.theme)
      throw new Error("Pi resume integration unavailable: active theme is inaccessible.");
    if (!peer.SessionManager)
      throw new Error("Pi resume integration unavailable: SessionManager is inaccessible.");

    installSessionListCache(peer.SessionManager, bridge.sessionLists);
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
        peer.theme!,
      );
    };
  } catch (error) {
    recordCompatibilityDiagnostic(error);
  }
}

export async function warmResumeCache(cwd: string, sessionDir?: string) {
  if (!cwd) return;

  try {
    const peer = await loadPiCodingAgentPeer();
    const sessions = await peer.SessionManager?.list?.(cwd, sessionDir);

    if (!Array.isArray(sessions)) return;
    for (let index = 0; index < sessions.length; index += 8) {
      sessions.slice(index, index + 8).forEach(enrichSessionSummary);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch (error) {
    recordCompatibilityDiagnostic(error);
  }
}

function installSessionListCache(
  SessionManager: AnyRecord,
  entries: Map<string, SessionListCacheEntry>,
) {
  const nativeList = SessionManager.list;
  const nativeListAll = SessionManager.listAll;

  if (typeof nativeList !== "function" || typeof nativeListAll !== "function")
    throw new Error("Pi resume integration unavailable: session loaders are inaccessible.");
  SessionManager.list = cachedSessionLoader("current", nativeList, entries);
  SessionManager.listAll = cachedSessionLoader("all", nativeListAll, entries);
}

function cachedSessionLoader(
  scope: string,
  nativeLoader: (...args: unknown[]) => Promise<AnyRecord[]>,
  entries: Map<string, SessionListCacheEntry>,
) {
  return async function loadCachedSessions(this: unknown, ...args: unknown[]) {
    const key = `${scope}:${JSON.stringify(
      args.filter((argument) => typeof argument !== "function"),
    )}`;
    const progress = [...args].reverse().find(
      (argument): argument is (loaded: number, total: number) => void =>
        typeof argument === "function",
    );
    const cached = entries.get(key);

    if (cached?.promise) return cloneSessions(await cached.promise);
    if (
      cached?.sessions &&
      cached.snapshot &&
      sessionFilesUnchanged(cached.snapshot)
    ) {
      progress?.(cached.sessions.length, cached.sessions.length);
      return cloneSessions(cached.sessions);
    }

    const pending = Promise.resolve(nativeLoader.apply(this, args)).then(
      (sessions) => {
        const stored = cloneSessions(sessions);
        entries.set(key, {
          sessions: stored,
          snapshot: snapshotSessionFiles(stored),
        });
        return stored;
      },
    );
    entries.set(key, { promise: pending });

    try {
      return cloneSessions(await pending);
    } catch (error) {
      entries.delete(key);
      throw error;
    }
  };
}

function cloneSessions(sessions: AnyRecord[]) {
  return sessions.map((session) => ({
    ...session,
    created: new Date(session.created),
    modified: new Date(session.modified),
  }));
}

function snapshotSessionFiles(sessions: AnyRecord[]): SessionFileSnapshot | undefined {
  if (sessions.length === 0) return undefined;
  const files = sessions
    .map((session) => session.path)
    .filter((file): file is string => typeof file === "string" && file.length > 0);
  const directories = new Set<string>();

  for (const file of files) {
    const directory = path.dirname(file);
    directories.add(directory);
    directories.add(path.dirname(directory));
  }

  try {
    return new Map(
      [...files, ...directories]
        .sort()
        .map((file) => {
          const stat = statSync(file);
          return [file, `${stat.mtimeMs}:${stat.size}`];
        }),
    );
  } catch {
    return undefined;
  }
}

function sessionFilesUnchanged(snapshot: SessionFileSnapshot) {
  try {
    for (const [file, fingerprint] of snapshot) {
      const stat = statSync(file);

      if (`${stat.mtimeMs}:${stat.size}` !== fingerprint) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function openDecoratedResumeSelector(
  mode: AnyRecord,
  nativeShowSessionSelector: (this: AnyRecord, ...args: unknown[]) => unknown,
  args: unknown[],
  theme: PiTheme,
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
        dispose = decorateResumeSelector(
          result?.component,
          () => mode.ui?.requestRender?.(),
          theme,
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
  theme?: PiTheme,
) {
  const list = component?.getSessionList?.();

  assertDecoratableSessionList(list);
  if (!isCompatibleTheme(theme))
    throw new Error("Pi resume integration unavailable: active theme is inaccessible.");
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

    return renderDecoratedRows(list, nativeRender(width), width, theme);
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

function renderDecoratedRows(
  list: AnyRecord,
  lines: string[],
  width: number,
  theme: PiTheme,
) {
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
    const lineIndex = rowOffset + index;

    if (
      sessionPresentation(node?.session) &&
      typeof result[lineIndex] === "string"
    )
      result[lineIndex] = renderDecoratedRow(
        list,
        node,
        start + index,
        width,
        theme,
      );
  });

  return result;
}

function renderDecoratedRow(
  list: AnyRecord,
  node: AnyRecord,
  index: number,
  width: number,
  theme: PiTheme,
) {
  const session = node.session;
  const original = originalSession(session) ?? session;
  const presentation = sessionPresentation(session)!;
  const isSelected = index === Number(list.selectedIndex ?? 0);
  const isConfirmingDelete = original.path === list.confirmingDeletePath;
  const isCurrent = list.isCurrentSessionPath?.(original.path) === true;
  const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
  const prefix = theme.fg("dim", treePrefix(node));
  const status = theme.fg(
    presentation.running ? "success" : "dim",
    presentation.running ? "●" : "○",
  );
  const agent = presentation.agentName
    ? `${theme.bold(styleAgentName(presentation.agentName, { bracketed: true }))} `
    : "";
  const left = `${cursor}${prefix}${status} ${agent}`;
  const id = presentation.shortId
    ? ` ${theme.fg("dim", `(${presentation.shortId})`)}`
    : "";
  const timerText = formatDuration(presentation.inactiveMs);
  const inactive = presentation.running
    ? ` ${theme.fg("dim", "Inactive:")} \x1b[95m${timerText}\x1b[39m${" ".repeat(Math.max(0, 8 - timerText.length))}`
    : "";
  const orchestrationMetadata = `${id}${inactive}`;
  const nativeMetadataWidth = Math.max(
    0,
    width - visibleWidth(left) - visibleWidth(orchestrationMetadata) - 12,
  );
  const nativeMetadata = truncateToWidth(
    nativeSessionMetadata(list, original),
    nativeMetadataWidth,
    "…",
  );
  const right = `${theme.fg("dim", nativeMetadata)}${orchestrationMetadata}`;
  const messageColor = isConfirmingDelete
    ? "error"
    : isCurrent
      ? "accent"
      : undefined;
  const available = Math.max(
    0,
    width - visibleWidth(left) - visibleWidth(right) - 2,
  );
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
    Math.max(
      1,
      width -
        visibleWidth(left) -
        visibleWidth(styledMessage) -
        visibleWidth(right),
    ),
  );
  let line = truncateToWidth(`${left}${styledMessage}${spacing}${right}`, width);

  if (isSelected) line = theme.bg("selectedBg", line);
  return line;
}

function nativeSessionMetadata(list: AnyRecord, session: AnyRecord) {
  const parts: string[] = [];

  if (list.showCwd && session.cwd) parts.push(shortenPath(session.cwd));
  if (list.showPath && session.path) parts.push(shortenPath(session.path));
  parts.push(String(session.messageCount), formatSessionDate(session.modified));
  return parts.join(" ");
}

function treePrefix(node: AnyRecord) {
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
  return (
    typeof theme?.fg === "function" &&
    typeof theme?.bg === "function" &&
    typeof theme?.bold === "function"
  );
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
