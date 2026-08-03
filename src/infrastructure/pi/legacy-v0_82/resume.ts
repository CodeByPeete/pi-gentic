import { statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Cache, Data, Duration, Effect, Fiber, FileSystem, Schedule, Schema, Stream } from "effect";
import type { ExtensionRuntime } from "../../../runtime/ExtensionRuntime.js";
import { defaultAgentDir, formatDuration, shortestUniqueSessionId, shortSessionId } from "../../../catalog.js";
import { reportRuntimeDiagnostic } from "../../../diagnostics.js";
import type { PiTheme } from "../../../pi-types.js";
import { getLiveRuntimeState, livePath, loadPiCodingAgentPeer } from "./bridge.js";
import {
  enrichSessionSummary,
  enrichSessionTreeSkeletonEffect,
  listAllFastSessionSkeletonsEffect,
  listFastSessionSkeletonsEffect,
  summarizeSession,
  withRuntimeState,
} from "../../../sessions.js";
import { styleAgentName } from "../../../ui.js";
import { runProcess } from "../../process/ProcessRunner.js";

const RESUME_BRIDGE_KEY = Symbol.for("pi-gentic.resume-bridge");
const ORIGINAL_SESSION = Symbol("pi-gentic.original-session");
const SESSION_PRESENTATION = Symbol("pi-gentic.session-presentation");
const REFRESH_INTERVAL_MS = 1000;
const FAST_RESUME_THRESHOLD = 100;
const RESUME_CACHE_CAPACITY = 4;
const PERSISTED_RESUME_CACHE_VERSION = 1;
const resumeRefreshers = new Set<(sessions?: LegacyRecord[]) => void>();
const SessionListSchema = Schema.Array(Schema.Record(Schema.String, Schema.Json));
const sessionListWorker = fileURLToPath(new URL("./session-list-worker.js", import.meta.url));

type LegacyRecord = Record<string, any>;

type SessionFileSnapshot = Map<string, string>;

class ResumeSessionListFailed extends Data.TaggedError("ResumeSessionListFailed")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function resumeFailure(message?: string) {
  return (cause: unknown) =>
    new ResumeSessionListFailed({
      message: message ?? (cause instanceof Error ? cause.message : String(cause)),
      cause,
    });
}

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

async function installSessionListCache(SessionManager: LegacyRecord, bridge: ResumeBridgeState) {
  const nativeList = SessionManager.list;
  const nativeListAll = SessionManager.listAll;

  if (typeof nativeList !== "function" || typeof nativeListAll !== "function")
    throw new Error("Pi resume integration unavailable: session loaders are inaccessible.");
  [SessionManager.list, SessionManager.listAll] = await bridge.runtime.runPromise(
    Effect.all([
      cachedSessionLoader("current", nativeList, nativeListAll, bridge),
      cachedSessionLoader("all", nativeListAll, nativeListAll, bridge),
    ]),
  );
}

function cachedSessionLoader(
  scope: "current" | "all",
  nativeLoader: (...args: unknown[]) => Promise<LegacyRecord[]>,
  nativeListAll: (...args: unknown[]) => Promise<LegacyRecord[]>,
  bridge: ResumeBridgeState,
) {
  return Effect.gen(function* () {
    const requests = new Map<string, { receiver: unknown; args: unknown[]; isolated?: boolean }>();
    const staleEntries = new Map<string, { sessions: LegacyRecord[]; snapshot?: SessionFileSnapshot }>();
    const cache = yield* Cache.make({
      capacity: RESUME_CACHE_CAPACITY,
      lookup: (key: string) =>
        Effect.tryPromise({
          try: async () => {
            const request = requests.get(key);
            if (!request) throw new Error(`Missing resume request ${key}.`);
            return request;
          },
          catch: resumeFailure(),
        }).pipe(
          Effect.flatMap((request) =>
            request.isolated
              ? loadSessionListIsolated(scope, request.args)
              : Effect.tryPromise({
                  try: () => loadNativeSessionList(scope, nativeLoader, nativeListAll, request.receiver, request.args),
                  catch: resumeFailure(),
                }).pipe(Effect.map((sessions) => sessions.map(enrichSessionSummary))),
          ),
          Effect.map(cloneSessions),
          Effect.map((sessions) => ({
            sessions,
            snapshot: snapshotSessionFiles(sessions, sessionDirectoryArgument(scope, requests.get(key)?.args ?? [])),
          })),
          Effect.tap((entry) =>
            Effect.sync(() => {
              staleEntries.delete(key);
              staleEntries.set(key, entry);
              if (staleEntries.size > RESUME_CACHE_CAPACITY) staleEntries.delete(staleEntries.keys().next().value!);
            }),
          ),
          Effect.tap((entry) =>
            Effect.promise(() => writePersistedResumeEntry(key, entry)).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => reportRuntimeDiagnostic("legacy-resume-cache-write", cause)),
              ),
            ),
          ),
          Effect.tap((entry) =>
            Effect.sync(() => publishSessionMetadata(entry.sessions)).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => reportRuntimeDiagnostic("legacy-resume-metadata-warm", cause)),
              ),
            ),
          ),
          Effect.ensuring(Effect.sync(() => requests.delete(key))),
        ),
    });

    return async function loadCachedSessions(this: unknown, ...args: unknown[]) {
      const key = sessionRequestKey(scope, args);
      const progress = [...args]
        .reverse()
        .find((argument): argument is (loaded: number, total: number) => void => typeof argument === "function");
      let cached =
        staleEntries.get(key) ??
        [...(await bridge.runtime.runPromise(Cache.entries(cache)))].find(([candidate]) => candidate === key)?.[1];

      if (!cached) {
        cached = await readPersistedResumeEntry(key);
        if (cached) staleEntries.set(key, cached);
      }

      if (cached) {
        const entry = cached;
        if (entry.snapshot && sessionFilesUnchanged(entry.snapshot)) {
          progress?.(entry.sessions.length, entry.sessions.length);
          return cloneSessions(entry.sessions);
        }
        const skeletons = await quickSessionList(scope, args, bridge.runtime);
        const cachedPaths = new Set(entry.sessions.map((session) => session.path));
        const sessions = reconcileSessionMembership(entry.sessions, skeletons).map((session) =>
          cachedPaths.has(session.path) ? session : { ...enrichSessionSummary(session), metadataPending: false },
        );

        progress?.(sessions.length, sessions.length);
        requests.set(key, {
          receiver: this,
          args,
          isolated: sessions.length > FAST_RESUME_THRESHOLD,
        });
        void bridge.runtime.runPromise(Cache.refresh(cache, key)).catch(recordCompatibilityDiagnostic);
        return cloneSessions(sessions);
      }

      const initial = await quickSessionList(scope, args, bridge.runtime);
      requests.set(key, { receiver: this, args, isolated: initial.length > FAST_RESUME_THRESHOLD });
      const pending = bridge.runtime
        .runPromise(Cache.get(cache, key))
        .then((entry) => entry.sessions)
        .catch(async (error) => {
          await bridge.runtime.runPromise(Cache.invalidate(cache, key));
          recordCompatibilityDiagnostic(error);
          throw error;
        });
      void pending.catch(() => undefined);

      if (initial.length > FAST_RESUME_THRESHOLD) {
        progress?.(initial.length, initial.length);
        return cloneSessions(initial);
      }
      return cloneSessions(await pending);
    };
  });
}

function sessionDirectoryArgument(scope: "current" | "all", args: unknown[]) {
  const value = args[scope === "current" ? 1 : 0];
  return typeof value === "string" ? value : undefined;
}

function sessionRequestKey(scope: "current" | "all", args: unknown[]) {
  const directory = sessionDirectoryArgument(scope, args);
  const sessionDir = directory ? path.resolve(directory) : undefined;

  if (sessionDir) return `${scope}:${sessionDir}`;
  return `${scope}:${JSON.stringify(args.filter((argument) => typeof argument !== "function"))}`;
}

function loadNativeSessionList(
  scope: "current" | "all",
  nativeLoader: (...args: unknown[]) => Promise<LegacyRecord[]>,
  nativeListAll: (...args: unknown[]) => Promise<LegacyRecord[]>,
  receiver: unknown,
  args: unknown[],
) {
  const sessionDir = sessionDirectoryArgument(scope, args);
  const progress = [...args].reverse().find((argument) => typeof argument === "function");

  return scope === "current" && sessionDir
    ? nativeListAll.apply(receiver, progress ? [sessionDir, progress] : [sessionDir])
    : nativeLoader.apply(receiver, args);
}

async function quickSessionList(scope: "current" | "all", args: unknown[], runtime: ExtensionRuntime) {
  const sessionDir =
    typeof args[scope === "current" ? 1 : 0] === "string" ? String(args[scope === "current" ? 1 : 0]) : undefined;
  const cwd = scope === "current" && typeof args[0] === "string" ? args[0] : sessionDir;

  if (scope === "all" && !sessionDir)
    return runtime.runPromise(listAllFastSessionSkeletonsEffect(path.join(defaultAgentDir(), "sessions")));
  if (!cwd || !sessionDir) return [];
  return runtime.runPromise(listFastSessionSkeletonsEffect(sessionDir, cwd));
}

export function visibleSessionMembership(mode: LegacyRecord) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const { cwd, sessionDir } = yield* Effect.try({
        try: () => ({
          cwd: mode.sessionManager.getCwd() as string,
          sessionDir: mode.sessionManager.getSessionDir() as string | undefined,
        }),
        catch: (cause) =>
          new ResumeSessionListFailed({ message: "Could not resolve the visible session scope.", cause }),
      });
      let knownPaths = new Set<string>();
      const initialMembership = listFastSessionSkeletonsEffect(sessionDir, cwd).pipe(
        Effect.tap((sessions) =>
          Effect.sync(() => {
            knownPaths = new Set(sessions.map((session) => String(session.path)));
          }),
        ),
      );
      const membership = listFastSessionSkeletonsEffect(sessionDir, cwd).pipe(
        Effect.flatMap((sessions) =>
          Effect.forEach(
            sessions,
            (session) =>
              knownPaths.has(String(session.path)) ? Effect.succeed(session) : enrichSessionTreeSkeletonEffect(session),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.tap((sessions) =>
          Effect.sync(() => {
            knownPaths = new Set(sessions.map((session) => String(session.path)));
          }),
        ),
      );
      const fallback = Stream.fromEffectSchedule(
        Effect.delay(membership, Duration.millis(250)),
        Schedule.spaced(Duration.millis(250)),
      );

      if (!sessionDir) return Stream.fromEffect(initialMembership);
      return Stream.fromEffect(initialMembership).pipe(Stream.concat(fallback));
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Stream.fromEffect(
            Effect.sync(() => {
              recordCompatibilityDiagnostic(error);
              return [];
            }),
          ),
        ),
      ),
    ),
  );
}

export const loadSessionListIsolated = Effect.fn("ResumeSession.listIsolated")(function* (
  scope: "current" | "all",
  args: unknown[],
) {
  const sessionDir =
    typeof args[scope === "current" ? 1 : 0] === "string" ? String(args[scope === "current" ? 1 : 0]) : undefined;
  const request =
    scope === "current"
      ? { scope, cwd: String(args[0]), ...(sessionDir ? { sessionDir } : {}) }
      : { scope, ...(sessionDir ? { sessionDir } : {}) };
  const result = yield* runProcess(process.execPath, [sessionListWorker, JSON.stringify(request)], {
    timeout: "120 seconds",
  }).pipe(Effect.mapError(resumeFailure("Isolated Pi session listing failed.")));

  if (result.exitCode !== 0)
    return yield* new ResumeSessionListFailed({
      message: result.stderr || `Isolated Pi session listing exited with ${result.exitCode}.`,
      cause: result.stderr,
    });
  const value = yield* Effect.try({
    try: () => JSON.parse(result.stdout),
    catch: resumeFailure("Isolated Pi session output was invalid JSON."),
  });

  const decoded = yield* Schema.decodeUnknownEffect(SessionListSchema)(value).pipe(
    Effect.mapError(resumeFailure("Isolated Pi session output was invalid.")),
  );

  return decoded.map((session): LegacyRecord => ({ ...session }));
});

function persistedResumeCachePath(key: string) {
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(defaultAgentDir(), "pi-gentic", "runtime", "resume-cache", `${digest}.json`);
}

async function readPersistedResumeEntry(key: string) {
  const file = persistedResumeCachePath(key);

  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isPersistedResumeEntry(parsed, key)) throw new Error("Persisted resume cache has an invalid structure.");

    return {
      sessions: cloneSessions(parsed.sessions),
      snapshot: new Map(parsed.snapshot),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    reportRuntimeDiagnostic("legacy-resume-cache-read", error);
    await rm(file, { force: true }).catch(() => undefined);
    return undefined;
  }
}

async function writePersistedResumeEntry(
  key: string,
  entry: { sessions: LegacyRecord[]; snapshot?: SessionFileSnapshot },
) {
  if (!entry.snapshot) return;
  const file = persistedResumeCachePath(key);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    temporary,
    JSON.stringify({
      version: PERSISTED_RESUME_CACHE_VERSION,
      key,
      sessions: entry.sessions,
      snapshot: [...entry.snapshot],
    }),
    "utf8",
  );
  await rename(temporary, file).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  });
}

function isPersistedResumeEntry(
  value: unknown,
  key: string,
): value is { version: number; key: string; sessions: LegacyRecord[]; snapshot: [string, string][] } {
  if (!value || typeof value !== "object") return false;
  const record = value as LegacyRecord;

  return (
    record.version === PERSISTED_RESUME_CACHE_VERSION &&
    record.key === key &&
    Array.isArray(record.sessions) &&
    record.sessions.every((session: unknown) => session !== null && typeof session === "object") &&
    Array.isArray(record.snapshot) &&
    record.snapshot.every(
      (item: unknown) =>
        Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && typeof item[1] === "string",
    )
  );
}

function publishSessionMetadata(sessions: LegacyRecord[]) {
  for (const refresh of resumeRefreshers) refresh(sessions);
}

function cloneSessions(sessions: LegacyRecord[]): LegacyRecord[] {
  return sessions.map((session) => ({
    ...session,
    created: new Date(session.created),
    modified: new Date(session.modified),
  }));
}

function reconcileSessionMembership(cached: LegacyRecord[], skeletons: LegacyRecord[]) {
  const cachedByPath = new Map(cached.map((session) => [session.path, session]));

  return skeletons.map((skeleton) => {
    const previous = cachedByPath.get(skeleton.path);
    if (!previous) return skeleton;

    return {
      ...previous,
      id: skeleton.id,
      path: skeleton.path,
      cwd: skeleton.cwd,
      created: skeleton.created,
      modified: skeleton.modified,
      ...(skeleton.parentSessionPath ? { parentSessionPath: skeleton.parentSessionPath } : {}),
    };
  });
}

function sameSessionMembership(left: LegacyRecord[], right: LegacyRecord[]) {
  return left.length === right.length && left.every((session, index) => session.path === right[index]?.path);
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
        dispose = decorateResumeSelector(
          result?.component,
          () => mode.ui?.requestRender?.(),
          theme,
          runtime,
          visibleSessionMembership(mode),
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
  component: LegacyRecord,
  requestRender = () => {},
  theme?: PiTheme,
  runtime?: ExtensionRuntime,
  membershipChanges?: Stream.Stream<LegacyRecord[], never, FileSystem.FileSystem>,
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
  const refresh = (hydrated: LegacyRecord[] = []) => {
    if (hydrated.length > 0) {
      const property = component.scope === "all" ? "allSessions" : "currentSessions";
      const current = (component[property] ?? list.allSessions ?? []).map(originalSession);
      const byPath = new Map(hydrated.map((session) => [session.path, session]));
      const sessions = current.map((session: LegacyRecord) => {
        const metadata = byPath.get(session.path);
        return metadata ? { ...session, ...metadata, metadataPending: false } : session;
      });

      if (sessions.some((session: LegacyRecord, index: number) => session !== current[index])) {
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
            const knownPaths = new Set(current.map((session: LegacyRecord) => session.path));
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
    const running = (list.allSessions ?? []).some(
      (session: DecoratedSession) => sessionPresentation(session)?.running === true,
    );

    if (running && !refreshFiber && runtime) {
      refreshFiber = runtime.runFork(
        Effect.sync(() => {
          refreshSessions();
          requestRender();
        }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(REFRESH_INTERVAL_MS)))),
      );
    } else if (!running && refreshFiber) {
      runtime?.runFork(Fiber.interrupt(refreshFiber));
      refreshFiber = undefined;
    }
  };

  list.setSessions = (sessions: LegacyRecord[], showCwd: boolean) => {
    const decorated = decorateSessions(sessions ?? []);
    const query = String(list.searchInput?.getValue?.() ?? "");
    const flatThread =
      list.sortMode === "threaded" &&
      list.nameFilter === "all" &&
      !query.trim() &&
      decorated.every((session) => !session.parentSessionPath);
    const result = flatThread ? setFlatThreadSessions(list, decorated, showCwd) : nativeSetSessions(decorated, showCwd);

    if (query.trim()) nativeFilterSessions(query);
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
    const switchPath = presentation?.running && presentation.sessionId ? livePath(presentation.sessionId) : sessionPath;

    return nativeOnSelect?.(switchPath);
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

function setFlatThreadSessions(list: LegacyRecord, sessions: DecoratedSession[], showCwd: boolean) {
  const ordered = [...sessions].sort(
    (left, right) => (right.modified as Date).getTime() - (left.modified as Date).getTime(),
  );

  list.allSessions = sessions;
  list.showCwd = showCwd;
  list.filteredSessions = ordered.map((session, index) => ({
    session,
    depth: 0,
    isLast: index === ordered.length - 1,
    ancestorContinues: [],
  }));
  list.selectedIndex = Math.min(list.selectedIndex, Math.max(0, ordered.length - 1));
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
  const shortIds = ids.map(shortSessionId);
  const shortIdCounts = new Map<string, number>();

  for (const shortId of shortIds) shortIdCounts.set(shortId, (shortIdCounts.get(shortId) ?? 0) + 1);
  const enrichImmediately = sessions.length <= 50;

  return sessions.map((session, index) => {
    const persisted = enrichImmediately ? enrichSessionSummary(session) : summarizeSession(session);
    const sessionId = ids[index];
    const shortId = shortIds[index] ?? shortSessionId(sessionId);
    const clone: DecoratedSession = { ...session };

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

function refreshDecoratedSession(session: DecoratedSession, persisted?: LegacyRecord) {
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
  const presentation: LegacyRecord = {
    ...previous,
    agentName: live.agentName ?? persisted.agentName ?? previous.agentName,
    lastMessage: persisted.lastMessage ?? previous.lastMessage,
    running: live.running === true,
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
