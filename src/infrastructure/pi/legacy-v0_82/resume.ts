import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Cache, Data, Duration, Effect, Fiber, Option, Schedule } from "effect";
import type { ExtensionRuntime } from "../../../runtime/ExtensionRuntime.js";
import { formatDuration, shortestUniqueSessionId, shortSessionId } from "../../../catalog.js";
import { reportRuntimeDiagnostic } from "../../../diagnostics.js";
import type { PiTheme } from "../../../pi-types.js";
import { getLiveRuntimeState, livePath, loadPiCodingAgentPeer } from "./bridge.js";
import {
  enrichSessionSummary,
  listSessionSkeletonsEffect,
  summarizeSession,
  withRuntimeState,
} from "../../../sessions.js";
import { styleAgentName } from "../../../ui.js";

const RESUME_BRIDGE_KEY = Symbol.for("pi-gentic.resume-bridge");
const ORIGINAL_SESSION = Symbol("pi-gentic.original-session");
const SESSION_PRESENTATION = Symbol("pi-gentic.session-presentation");
const REFRESH_INTERVAL_MS = 1000;
const FAST_RESUME_THRESHOLD = 100;
const resumeRefreshers = new Set<() => void>();

type LegacyRecord = Record<string, any>;

type SessionFileSnapshot = Map<string, string>;

class ResumeSessionListFailed extends Data.TaggedError("ResumeSessionListFailed")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

type ResumeBridgeState = {
  installed: boolean;
  runtime: ExtensionRuntime;
  originalShowSessionSelector?: (this: LegacyRecord, ...args: unknown[]) => unknown;
};

type DecoratedSession = LegacyRecord & {
  [ORIGINAL_SESSION]?: LegacyRecord;
  [SESSION_PRESENTATION]?: LegacyRecord;
};

export async function installResumeBridge(runtime: ExtensionRuntime) {
  const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
  const bridge = (globalState[RESUME_BRIDGE_KEY] ??= {
    installed: false,
    runtime,
  }) as ResumeBridgeState;
  bridge.runtime = runtime;

  if (bridge.installed) return;

  try {
    const peer = await loadPiCodingAgentPeer();
    const prototype = peer.InteractiveMode?.prototype;
    const nativeShowSessionSelector = prototype?.showSessionSelector;

    if (typeof nativeShowSessionSelector !== "function")
      throw new Error("Pi resume integration unavailable: InteractiveMode.showSessionSelector is missing.");
    if (!peer.theme) throw new Error("Pi resume integration unavailable: active theme is inaccessible.");
    if (!peer.SessionManager) throw new Error("Pi resume integration unavailable: SessionManager is inaccessible.");

    await installSessionListCache(peer.SessionManager, bridge);
    bridge.installed = true;
    bridge.originalShowSessionSelector = nativeShowSessionSelector;
    const interactivePrototype = prototype as LegacyRecord;
    interactivePrototype.showSessionSelector = function showSessionSelectorWithPiGentic(
      this: LegacyRecord,
      ...args: unknown[]
    ) {
      return openDecoratedResumeSelector(this, bridge.originalShowSessionSelector!, args, peer.theme!, bridge.runtime);
    };
  } catch (error) {
    recordCompatibilityDiagnostic(error);
  }
}

export async function warmResumeCache(cwd: string, sessionDir?: string) {
  if (!cwd) return;

  try {
    const peer = await loadPiCodingAgentPeer();
    await peer.SessionManager?.list?.(cwd, sessionDir);
  } catch (error) {
    recordCompatibilityDiagnostic(error);
  }
}

async function installSessionListCache(SessionManager: LegacyRecord, bridge: ResumeBridgeState) {
  const nativeList = SessionManager.list;
  const nativeListAll = SessionManager.listAll;

  if (typeof nativeList !== "function" || typeof nativeListAll !== "function")
    throw new Error("Pi resume integration unavailable: session loaders are inaccessible.");
  [SessionManager.list, SessionManager.listAll] = await bridge.runtime.runPromise(
    Effect.all([cachedSessionLoader("current", nativeList, bridge), cachedSessionLoader("all", nativeListAll, bridge)]),
  );
}

function cachedSessionLoader(
  scope: string,
  nativeLoader: (...args: unknown[]) => Promise<LegacyRecord[]>,
  bridge: ResumeBridgeState,
) {
  return Effect.gen(function* () {
    const requests = new Map<string, { receiver: unknown; args: unknown[] }>();
    const cache = yield* Cache.make({
      capacity: 32,
      lookup: (key: string) =>
        Effect.tryPromise({
          try: async () => {
            const request = requests.get(key);
            if (!request) throw new Error(`Missing resume request ${key}.`);
            const sessions = cloneSessions(await nativeLoader.apply(request.receiver, request.args));
            void warmSessionMetadata(bridge.runtime, sessions).catch(recordCompatibilityDiagnostic);
            return {
              sessions,
              snapshot:
                sessions.length <= FAST_RESUME_THRESHOLD
                  ? snapshotSessionFiles(sessions, typeof request.args[1] === "string" ? request.args[1] : undefined)
                  : undefined,
            };
          },
          catch: (cause) =>
            new ResumeSessionListFailed({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }),
    });

    return async function loadCachedSessions(this: unknown, ...args: unknown[]) {
      const key = `${scope}:${JSON.stringify(args.filter((argument) => typeof argument !== "function"))}`;
      const progress = [...args]
        .reverse()
        .find((argument): argument is (loaded: number, total: number) => void => typeof argument === "function");
      requests.set(key, { receiver: this, args });
      const cached = await bridge.runtime.runPromise(Cache.getOption(cache, key));

      if (Option.isSome(cached)) {
        const entry = cached.value;
        if (!entry.snapshot || sessionFilesUnchanged(entry.snapshot)) {
          progress?.(entry.sessions.length, entry.sessions.length);
          if (!entry.snapshot)
            void bridge.runtime.runPromise(Cache.refresh(cache, key)).catch(recordCompatibilityDiagnostic);
          return cloneSessions(entry.sessions);
        }
        await bridge.runtime.runPromise(Cache.invalidate(cache, key));
      }

      const pending = bridge.runtime
        .runPromise(Cache.get(cache, key))
        .then((entry) => entry.sessions)
        .catch(async (error) => {
          await bridge.runtime.runPromise(Cache.invalidate(cache, key));
          recordCompatibilityDiagnostic(error);
          throw error;
        });
      void pending.catch(() => undefined);
      const initial = await quickSessionList(scope, args, bridge.runtime);

      if (initial.length > FAST_RESUME_THRESHOLD) {
        progress?.(initial.length, initial.length);
        return cloneSessions(initial);
      }
      return cloneSessions(await pending);
    };
  });
}

async function quickSessionList(scope: string, args: unknown[], runtime: ExtensionRuntime) {
  if (scope !== "current") return [];
  const cwd = typeof args[0] === "string" ? args[0] : undefined;
  const sessionDir = typeof args[1] === "string" ? args[1] : undefined;

  if (!cwd || !sessionDir) return [];
  const skeletons = await runtime.runPromise(listSessionSkeletonsEffect(sessionDir, cwd));

  return skeletons.length > FAST_RESUME_THRESHOLD ? skeletons : [];
}

async function warmSessionMetadata(runtime: ExtensionRuntime, sessions: LegacyRecord[]) {
  const chunks = Array.from({ length: Math.ceil(sessions.length / 8) }, (_, index) =>
    sessions.slice(index * 8, index * 8 + 8),
  );

  await runtime.runPromise(
    Effect.forEach(
      chunks,
      (chunk) =>
        Effect.sync(() => {
          chunk.forEach(enrichSessionSummary);
          for (const refresh of resumeRefreshers) refresh();
        }).pipe(Effect.andThen(Effect.yieldNow)),
      { discard: true },
    ),
  );
}

function cloneSessions(sessions: LegacyRecord[]) {
  return sessions.map((session) => ({
    ...session,
    created: new Date(session.created),
    modified: new Date(session.modified),
  }));
}

function snapshotSessionFiles(sessions: LegacyRecord[], sessionDir?: string): SessionFileSnapshot | undefined {
  const sessionFiles = sessions
    .map((session) => session.path)
    .filter((file): file is string => typeof file === "string" && file.length > 0);
  const files = sessionDir ? [sessionDir, ...sessionFiles] : sessionFiles;
  if (files.length === 0) return undefined;
  const directories = new Set(sessionFiles.map((file) => path.dirname(file)));

  try {
    return new Map(
      [...files, ...directories].sort().map((file) => {
        const stat = statSync(file);
        return [file, `${stat.mtimeMs}:${stat.size}`];
      }),
    );
  } catch (error) {
    reportRuntimeDiagnostic("legacy-resume-fingerprint", error);
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
  } catch (error) {
    reportRuntimeDiagnostic("legacy-resume-cache-validation", error);
    return false;
  }
}

function openDecoratedResumeSelector(
  mode: LegacyRecord,
  nativeShowSessionSelector: (this: LegacyRecord, ...args: unknown[]) => unknown,
  args: unknown[],
  theme: PiTheme,
  runtime: ExtensionRuntime,
) {
  const nativeShowSelector = mode.showSelector;

  if (typeof nativeShowSelector !== "function") return nativeShowSessionSelector.apply(mode, args);

  mode.showSelector = function showDecoratedSelector(create: (done: () => void) => LegacyRecord) {
    return nativeShowSelector.call(this, (done: () => void) => {
      let dispose = () => {};
      const result = create(() => {
        dispose();
        done();
      });

      try {
        dispose = decorateResumeSelector(result?.component, () => mode.ui?.requestRender?.(), theme, runtime);
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
  component: LegacyRecord,
  requestRender = () => {},
  theme?: PiTheme,
  runtime?: ExtensionRuntime,
) {
  const list = component?.getSessionList?.();

  assertDecoratableSessionList(list);
  if (!isCompatibleTheme(theme)) throw new Error("Pi resume integration unavailable: active theme is inaccessible.");
  const nativeSetSessions = list.setSessions.bind(list);
  const nativeFilterSessions = list.filterSessions.bind(list);
  const nativeRender = list.render.bind(list);
  const nativeOnSelect = list.onSelect;
  const nativeDispose = component.dispose?.bind(component);
  let refreshFiber: Fiber.Fiber<unknown, never> | undefined;
  let disposed = false;

  const refreshSessions = () => {
    for (const session of list.allSessions ?? []) refreshDecoratedSession(session);
  };
  const refresh = () => {
    refreshSessions();
    requestRender();
  };
  resumeRefreshers.add(refresh);
  const syncRefreshTimer = () => {
    const running = (list.allSessions ?? []).some(
      (session: DecoratedSession) => sessionPresentation(session)?.running === true,
    );

    if (running && !refreshFiber && runtime) {
      refreshFiber = runtime.runFork(
        Effect.sync(() => {
          refreshSessions();
          requestRender();
        }).pipe(Effect.repeat(Schedule.fixed(Duration.millis(REFRESH_INTERVAL_MS)))),
      );
    } else if (!running && refreshFiber) {
      runtime?.runFork(Fiber.interrupt(refreshFiber));
      refreshFiber = undefined;
    }
  };

  list.setSessions = (sessions: LegacyRecord[], showCwd: boolean) => {
    const decorated = decorateSessions(sessions ?? []);
    const result = nativeSetSessions(decorated, showCwd);

    syncRefreshTimer();
    return result;
  };
  list.filterSessions = (query: string) => {
    refreshSessions();
    return nativeFilterSessions(query);
  };
  list.render = (width: number) => {
    refreshSessions();
    syncRefreshTimer();

    return renderDecoratedRows(list, nativeRender(width), width, theme);
  };
  list.onSelect = (sessionPath: string) => {
    const session = (list.allSessions ?? []).find(
      (candidate: DecoratedSession) => originalSession(candidate)?.path === sessionPath,
    );
    const presentation = sessionPresentation(session);
    const switchPath = presentation?.running && presentation.sessionId ? livePath(presentation.sessionId) : sessionPath;

    return nativeOnSelect?.(switchPath);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (refreshFiber) runtime?.runFork(Fiber.interrupt(refreshFiber));
    refreshFiber = undefined;
    resumeRefreshers.delete(refresh);
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

function assertDecoratableSessionList(list: LegacyRecord) {
  const required = ["setSessions", "filterSessions", "render"].filter((method) => typeof list?.[method] !== "function");

  if (required.length > 0 || !Array.isArray(list?.allSessions) || !Array.isArray(list?.filteredSessions))
    throw new Error(
      `Pi resume integration unavailable: unsupported native session list${
        required.length ? ` (${required.join(", ")})` : ""
      }.`,
    );
}

function decorateSessions(sessions: LegacyRecord[]) {
  const ids = sessions.map((session) => session.id ?? session.sessionId);
  const shortIdCounts = new Map<string, number>();

  for (const id of ids) {
    const shortId = shortSessionId(id);
    shortIdCounts.set(shortId, (shortIdCounts.get(shortId) ?? 0) + 1);
  }
  const enrichImmediately = sessions.length <= 50;

  return sessions.map((session) => {
    const persisted = enrichImmediately ? enrichSessionSummary(session) : summarizeSession(session);
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
          shortId:
            shortIdCounts.get(shortSessionId(session.id ?? session.sessionId)) === 1
              ? shortSessionId(session.id ?? session.sessionId)
              : shortestUniqueSessionId(session.id ?? session.sessionId, ids),
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
  const persisted = summarizeSession(original);
  const live = withRuntimeState({
    ...original,
    sessionId: previous.sessionId,
    agentName: persisted.agentName ?? previous.agentName,
  });
  const presentation: LegacyRecord = {
    ...previous,
    agentName: live.agentName ?? persisted.agentName ?? previous.agentName,
    lastMessage: persisted.lastMessage ?? previous.lastMessage,
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

function renderDecoratedRows(list: LegacyRecord, lines: string[], width: number, theme: PiTheme) {
  const filtered = list.filteredSessions ?? [];
  const maxVisible = Math.max(1, Number(list.maxVisible ?? 10));
  const selectedIndex = Math.min(Math.max(0, Number(list.selectedIndex ?? 0)), Math.max(0, filtered.length - 1));
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
  const visible = filtered.slice(start, Math.min(start + maxVisible, filtered.length));
  const searchLineCount = list.searchInput?.render?.(width)?.length ?? 1;
  const rowOffset = searchLineCount + 1;
  const result = [...lines];

  visible.forEach((node: LegacyRecord, index: number) => {
    const lineIndex = rowOffset + index;

    if (sessionPresentation(node?.session) && typeof result[lineIndex] === "string")
      result[lineIndex] = renderDecoratedRow(list, node, start + index, width, theme);
  });

  return result;
}

function renderDecoratedRow(list: LegacyRecord, node: LegacyRecord, index: number, width: number, theme: PiTheme) {
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
    ? ` ${theme.fg("dim", "Inactive:")} \x1b[95m${timerText}\x1b[39m${" ".repeat(Math.max(0, 8 - timerText.length))}`
    : "";
  const orchestrationMetadata = `${id}${inactive}`;
  const nativeMetadataWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(orchestrationMetadata) - 12);
  const nativeMetadata = truncateToWidth(nativeSessionMetadata(list, original), nativeMetadataWidth, "…");
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

function nativeSessionMetadata(list: LegacyRecord, session: LegacyRecord) {
  const parts: string[] = [];

  if (list.showCwd && session.cwd) parts.push(shortenPath(session.cwd));
  if (list.showPath && session.path) parts.push(shortenPath(session.path));
  parts.push(String(session.messageCount), formatSessionDate(session.modified));
  return parts.join(" ");
}

function treePrefix(node: LegacyRecord) {
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

function sessionPresentation(session: DecoratedSession | undefined): LegacyRecord | undefined {
  return session?.[SESSION_PRESENTATION];
}

function recordCompatibilityDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics = getLiveRuntimeState().compatibilityDiagnostics;

  if (!diagnostics.includes(message)) diagnostics.push(message);
}
