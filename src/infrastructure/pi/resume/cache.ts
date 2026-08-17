import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cache, Data, Duration, Effect, Schedule, Schema, Stream } from "effect";
import { defaultAgentDir } from "../../configuration/agents.js";
import { reportRuntimeDiagnostic } from "../../../shared/diagnostics.js";
import type { ExtensionRuntime } from "../../../runtime/ExtensionRuntime.js";
import {
  enrichSessionTreeSkeletonEffect,
  enrichSessionTreeWindowEffect,
  listAllFastSessionSkeletonsEffect,
  listFastSessionSkeletonsEffect,
} from "../../../application/sessions/directory.js";
import { enrichSessionSummary } from "../../../application/sessions/model.js";
import { runProcess } from "../../process/ProcessRunner.js";
import { getLiveRuntimeState, type HostRecord } from "../state.js";

const FAST_RESUME_THRESHOLD = 100;
const RESUME_CACHE_CAPACITY = 4;
const PERSISTED_RESUME_CACHE_VERSION = 1;
const SessionListSchema = Schema.Array(Schema.Record(Schema.String, Schema.Json));
const sessionListWorker = fileURLToPath(new URL("./worker.js", import.meta.url));

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

export async function installSessionListCache(
  SessionManager: HostRecord,
  runtime: ExtensionRuntime,
  publishMetadata: (sessions: HostRecord[]) => void,
) {
  const nativeList = SessionManager.list;
  const nativeListAll = SessionManager.listAll;

  if (typeof nativeList !== "function" || typeof nativeListAll !== "function")
    throw new Error("Pi resume integration unavailable: session loaders are inaccessible.");
  [SessionManager.list, SessionManager.listAll] = await runtime.runPromise(
    Effect.all([
      cachedSessionLoader("current", nativeList, nativeListAll, runtime, publishMetadata),
      cachedSessionLoader("all", nativeListAll, nativeListAll, runtime, publishMetadata),
    ]),
  );
}

function cachedSessionLoader(
  scope: "current" | "all",
  nativeLoader: (...args: unknown[]) => Promise<HostRecord[]>,
  nativeListAll: (...args: unknown[]) => Promise<HostRecord[]>,
  runtime: ExtensionRuntime,
  publishMetadata: (sessions: HostRecord[]) => void,
) {
  return Effect.gen(function* () {
    const requests = new Map<string, { receiver: unknown; args: unknown[]; isolated?: boolean }>();
    const staleEntries = new Map<string, { sessions: HostRecord[]; snapshot?: SessionFileSnapshot }>();
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
                Effect.sync(() => reportRuntimeDiagnostic("pi-host-resume-cache-write", cause)),
              ),
            ),
          ),
          Effect.tap((entry) =>
            Effect.sync(() => publishMetadata(entry.sessions)).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => reportRuntimeDiagnostic("pi-host-resume-metadata-warm", cause)),
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
        [...(await runtime.runPromise(Cache.entries(cache)))].find(([candidate]) => candidate === key)?.[1];

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
        const skeletons = await quickSessionList(scope, args, runtime);
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
        void runtime.runPromise(Cache.refresh(cache, key)).catch(recordSessionListDiagnostic);
        return cloneSessions(sessions);
      }

      const initial = await quickSessionList(scope, args, runtime);
      requests.set(key, { receiver: this, args, isolated: initial.length > FAST_RESUME_THRESHOLD });
      const pending = runtime
        .runPromise(Cache.get(cache, key))
        .then((entry) => entry.sessions)
        .catch(async (error) => {
          await runtime.runPromise(Cache.invalidate(cache, key));
          recordSessionListDiagnostic(error);
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
  nativeLoader: (...args: unknown[]) => Promise<HostRecord[]>,
  nativeListAll: (...args: unknown[]) => Promise<HostRecord[]>,
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

  let skeletons: HostRecord[];

  if (scope === "all" && !sessionDir)
    skeletons = await runtime.runPromise(listAllFastSessionSkeletonsEffect(path.join(defaultAgentDir(), "sessions")));
  else if (cwd && sessionDir) skeletons = await runtime.runPromise(listFastSessionSkeletonsEffect(sessionDir, cwd));
  else skeletons = [];

  return runtime.runPromise(enrichSessionTreeWindowEffect(skeletons, FAST_RESUME_THRESHOLD));
}

export function visibleSessionMembership(mode: HostRecord) {
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
              recordHostDiagnostic(error);
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

  return decoded.map((session): HostRecord => ({ ...session }));
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
    reportRuntimeDiagnostic("pi-host-resume-cache-read", error);
    await rm(file, { force: true }).catch(() => undefined);
    return undefined;
  }
}

async function writePersistedResumeEntry(
  key: string,
  entry: { sessions: HostRecord[]; snapshot?: SessionFileSnapshot },
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
): value is { version: number; key: string; sessions: HostRecord[]; snapshot: [string, string][] } {
  if (!value || typeof value !== "object") return false;
  const record = value as HostRecord;

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

function cloneSessions(sessions: HostRecord[]): HostRecord[] {
  return sessions.map((session) => ({
    ...session,
    created: new Date(session.created),
    modified: new Date(session.modified),
  }));
}

export function reconcileSessionMembership(cached: HostRecord[], skeletons: HostRecord[]) {
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

export function sameSessionMembership(left: HostRecord[], right: HostRecord[]) {
  return left.length === right.length && left.every((session, index) => session.path === right[index]?.path);
}

function snapshotSessionFiles(sessions: HostRecord[], sessionDir?: string): SessionFileSnapshot | undefined {
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
    reportRuntimeDiagnostic("pi-host-resume-fingerprint", error);
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
    reportRuntimeDiagnostic("pi-host-resume-cache-validation", error);
    return false;
  }
}

function recordSessionListDiagnostic(error: unknown) {
  reportRuntimeDiagnostic(
    "pi-host-resume-session-list",
    error instanceof ResumeSessionListFailed ? error.cause : error,
  );
}

function recordHostDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics = getLiveRuntimeState().hostDiagnostics;

  if (!diagnostics.includes(message)) diagnostics.push(message);
}
