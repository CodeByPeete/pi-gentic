import { open, stat } from "node:fs/promises";
import path from "node:path";
import { Effect, FileSystem } from "effect";
import { reportRuntimeDiagnostic } from "../shared/diagnostics.js";
import { normalizedPath } from "../shared/values.js";
import type { UnknownRecord } from "../shared/values.js";
import { isRecord, shortSessionId } from "../shared/values.js";
import { modifiedTime } from "./catalog.js";

const SESSION_SKELETON_CONCURRENCY = 64;

export const listFastSessionSkeletonsEffect = Effect.fn("SessionDirectory.listFastSkeletons")(function* (
  sessionDir: string | undefined,
  cwd: string,
) {
  if (!sessionDir) return [];
  const fileSystem = yield* FileSystem.FileSystem;
  const names = (yield* fileSystem.readDirectory(sessionDir).pipe(Effect.orElseSucceed(() => []))).filter((name) =>
    name.endsWith(".jsonl"),
  );
  const sessions = names.map((name) => basicSessionSkeleton(path.join(sessionDir, name), cwd));

  return sessions.sort((left, right) => modifiedTime(right) - modifiedTime(left));
});

function basicSessionSkeleton(filePath: string, cwd: string): UnknownRecord {
  const name = path.basename(filePath);
  const id = sessionIdFromFileName(name);
  const created = sessionDateFromFileName(name);

  return {
    id,
    path: filePath,
    cwd,
    created,
    modified: created,
    messageCount: 0,
    firstMessage: `Session ${shortSessionId(id)}`,
    allMessagesText: `${id} ${filePath}`,
    metadataPending: true,
  };
}

export const enrichSessionTreeSkeletonEffect = Effect.fn("SessionDirectory.enrichTreeSkeleton")(function* (
  skeleton: UnknownRecord,
) {
  const skeletonPath = skeleton.path;

  if (typeof skeletonPath !== "string") return skeleton;
  return yield* Effect.promise(() => treeSessionSkeleton(skeletonPath, String(skeleton.cwd ?? "")));
});

/** Enriches the leading session window and its ancestors for a fast, structurally correct initial tree. */
export const enrichSessionTreeWindowEffect = Effect.fn("SessionDirectory.enrichTreeWindow")(function* (
  skeletons: UnknownRecord[],
  windowSize = skeletons.length,
) {
  const skeletonsByPath = new Map<string, UnknownRecord>();
  for (const skeleton of skeletons) {
    const key = normalizedPath(skeleton.path);
    if (key) skeletonsByPath.set(key, skeleton);
  }
  const enrichedByPath = new Map<string, UnknownRecord>();
  let pending = skeletons.slice(0, Math.max(0, Math.floor(windowSize)));
  const scheduledPaths = new Set<string>();
  for (const skeleton of pending) {
    const key = normalizedPath(skeleton.path);
    if (key) scheduledPaths.add(key);
  }

  while (pending.length > 0) {
    const batch = pending;
    pending = [];
    const enriched = yield* Effect.forEach(batch, enrichSessionTreeSkeletonEffect, {
      concurrency: SESSION_SKELETON_CONCURRENCY,
    });

    for (const [index, session] of enriched.entries()) {
      const source = batch[index];

      if (!source) continue;
      const key = normalizedPath(source.path);

      if (key) enrichedByPath.set(key, session);
      const parentKey = normalizedPath(session.parentSessionPath);
      const parent = parentKey ? skeletonsByPath.get(parentKey) : undefined;

      if (parent && parentKey && !scheduledPaths.has(parentKey)) {
        scheduledPaths.add(parentKey);
        pending.push(parent);
      }
    }
  }

  return skeletons.map((skeleton) => enrichedByPath.get(normalizedPath(skeleton.path) ?? "") ?? skeleton);
});

async function treeSessionSkeleton(filePath: string, fallbackCwd: string) {
  const fallback = basicSessionSkeleton(filePath, fallbackCwd);

  try {
    await using file = await open(filePath, "r");
    const buffer = Buffer.allocUnsafe(4 * 1024);
    const [{ bytesRead }, fileStat] = await Promise.all([file.read(buffer, 0, buffer.length, 0), stat(filePath)]);
    const header = parseJsonLine(buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0]);

    if (header?.type !== "session") return fallback;
    return {
      ...fallback,
      id: typeof header.id === "string" ? header.id : fallback.id,
      cwd: typeof header.cwd === "string" ? header.cwd : fallback.cwd,
      created: typeof header.timestamp === "string" ? new Date(header.timestamp) : fallback.created,
      modified: fileStat.mtime,
      ...(typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}),
    };
  } catch (error) {
    reportRuntimeDiagnostic("session-skeleton", error);
    return fallback;
  }
}

function parseJsonLine(line: string | undefined): UnknownRecord | undefined {
  try {
    const value: unknown = line?.trim() ? JSON.parse(line) : undefined;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export const listAllFastSessionSkeletonsEffect = Effect.fn("SessionDirectory.listAllFastSkeletons")(function* (
  sessionsDir: string,
) {
  return yield* listAllSessionSkeletons(sessionsDir, listFastSessionSkeletonsEffect);
});

function listAllSessionSkeletons(
  sessionsDir: string,
  listDirectory: (sessionDir: string, cwd: string) => Effect.Effect<UnknownRecord[], never, FileSystem.FileSystem>,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const names = yield* fileSystem.readDirectory(sessionsDir).pipe(Effect.orElseSucceed(() => []));
    const directories = yield* Effect.filter(
      names.map((name) => path.join(sessionsDir, name)),
      (entry) =>
        fileSystem.stat(entry).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        ),
      { concurrency: "unbounded" },
    );
    const sessions = yield* Effect.forEach(directories, (directory) => listDirectory(directory, directory), {
      concurrency: "unbounded",
    });

    return sessions.flat().sort((left, right) => modifiedTime(right) - modifiedTime(left));
  });
}

function sessionIdFromFileName(name: string) {
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);

  return match?.[1] ?? name.replace(/\.jsonl$/i, "");
}

function sessionDateFromFileName(name: string) {
  const match = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);

  return match ? new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : new Date(0);
}
