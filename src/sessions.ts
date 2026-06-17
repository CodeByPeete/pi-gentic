/**
 * Session identity, summaries, and tree discovery.
 *
 * The rest of pi-gentic can ask for sessions by human-friendly ids while this
 * module handles paths, short ids, parent links, and runtime overlays.
 */
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { shortSessionId } from "./core.js";
import { getActiveState } from "./policy.js";
import {
  findRuntimeSession,
  listRuntimeSessions,
  livePath,
  registerLiveRuntime,
} from "./runtime.js";

/** Resolves a full id, short id, prefix, substring, or path to one session. */
export function resolveSessionReference(sessions, reference) {
  if (!reference) throw new Error("sessionId is required.");
  const query = String(reference).toLowerCase();
  const matches = sessions.filter((session) =>
    sessionKeys(session).some(
      (key) =>
        String(key).toLowerCase() === query ||
        String(key).toLowerCase().includes(query),
    ),
  );
  const unique = uniqueBy(matches, (session) => session.path ?? session.id);

  if (unique.length === 0)
    throw new Error(`No session matches "${reference}".`);

  if (unique.length > 1)
    throw new Error(
      `Ambiguous session reference "${reference}" matches ${unique.length} sessions.`,
    );

  return unique[0];
}

const persistedSummaryCache = new Map();
const persistedSessionListCache = new Map();

export function listSessionSummariesFast(sessionDir: string | undefined) {
  if (!sessionDir || !existsSync(sessionDir)) return [];

  return readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => fastSessionSummary(path.join(sessionDir, name)))
    .filter(Boolean)
    .sort((a, b) => modifiedTime(b) - modifiedTime(a));
}

function fastSessionSummary(filePath: string) {
  try {
    const stat = statSync(filePath);
    const lines = readFileHead(filePath).split(/\r?\n/);
    const header = parseLine(lines[0]);

    if (header?.type !== "session") return undefined;
    const details: AnyRecord = {
      id: header.id,
      path: filePath,
      cwd: header.cwd,
      parentSessionPath: header.parentSession,
      created: header.timestamp,
      modified: stat.mtime,
      firstMessage: "(no messages)",
    };

    for (const line of lines.slice(1)) {
      const entry = parseLine(line);

      if (!entry) continue;
      if (entry.type === "session_info" && typeof entry.name === "string")
        details.name = entry.name.trim() || undefined;

      if (entry.type === "message" && entry.message?.role === "user") {
        const text = extractText(entry.message.content);

        if (text) {
          details.firstMessage = cleanSessionMessage(text);
          break;
        }
      }
    }

    return details;
  } catch {
    return undefined;
  }
}

function readFileHead(filePath: string, bytes = 64 * 1024) {
  const fd = openSync(filePath, "r");

  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);

    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseLine(line: string) {
  try {
    return line?.trim() ? JSON.parse(line) : undefined;
  } catch {
    return undefined;
  }
}

export async function cachedPersistedSessions(
  key: string,
  load: () => Promise<AnyRecord[]>,
  maxAgeMs = 15_000,
) {
  const now = Date.now();
  const cached = persistedSessionListCache.get(key);

  if (cached?.sessions && now - cached.updatedAt < maxAgeMs)
    return cached.sessions;

  if (cached?.promise) return cached.promise;
  const promise = load()
    .then((sessions) => {
      persistedSessionListCache.set(key, {
        sessions,
        updatedAt: Date.now(),
        promise: undefined,
      });

      return sessions;
    })
    .catch((error) => {
      if (cached?.sessions) return cached.sessions;
      persistedSessionListCache.delete(key);
      throw error;
    });

  persistedSessionListCache.set(key, {
    sessions: cached?.sessions,
    updatedAt: cached?.updatedAt ?? 0,
    promise,
  });

  return promise;
}

export function warmPersistedSessions(
  key: string,
  load: () => Promise<AnyRecord[]>,
) {
  void cachedPersistedSessions(key, load).catch(() => undefined);
}

export function summarizeSession(session, options: AnyRecord = {}) {
  const persisted =
    options.enrich === true
      ? readPersistedSessionSummary(session.path, session.modified)
      : cachedPersistedSessionSummary(session.path, session.modified);

  return {
    id: session.id,
    sessionId: session.id,
    shortId: shortSessionId(session.id),
    path: session.path,
    parentSessionPath: session.parentSessionPath,
    name: session.name,
    firstMessage: persisted.firstUserMessage ?? session.firstMessage,
    lastMessage:
      persisted.lastUserMessage ?? session.name ?? session.firstMessage,
    modified: session.modified,
    agentName: persisted.agentName,
  };
}

export function enrichSessionSummary(session) {
  return session?.path
    ? { ...session, ...summarizeSession(session, { enrich: true }) }
    : session;
}

export function enrichSessionSummaries(sessions: AnyRecord[], limit = sessions.length) {
  return sessions.map((session, index) =>
    index < limit ? enrichSessionSummary(session) : session,
  );
}

/** Orders sessions so every child appears directly under its parent. */
export function orderSessionTree(sessions) {
  const byKey = sessionKeyMap(sessions);
  const children = new Map();
  const roots = [];

  for (const session of sessions) {
    const parent = parentSession(session, byKey);

    if (!parent) roots.push(session);
    else {
      const parentKey = primarySessionKey(parent);
      children.set(parentKey, [...(children.get(parentKey) ?? []), session]);
    }
  }

  const ordered = [];
  const subtreeModified = (session) =>
    Math.max(
      modifiedTime(session),
      ...(children.get(primarySessionKey(session)) ?? []).map(subtreeModified),
    );
  const sortByTreeActivity = (items) => sortSessions(items, subtreeModified);
  const visit = (session, depth = 0, siblingIndex = 0, siblingCount = 1) => {
    const nested = sortByTreeActivity(
      children.get(primarySessionKey(session)) ?? [],
    );
    ordered.push({
      ...session,
      depth,
      isLast: siblingIndex === siblingCount - 1,
    });
    nested.forEach((child, index) =>
      visit(child, depth + 1, index, nested.length),
    );
  };

  sortByTreeActivity(roots).forEach((root, index, sortedRoots) =>
    visit(root, 0, index, sortedRoots.length),
  );

  return ordered;
}

export function treeSwitchPath(session) {
  return session.running === true
    ? (session.livePath ?? session.path)
    : (session.path ?? session.livePath);
}

export function sessionDiscoveryScope(
  sessions: AnyRecord[],
  currentSession: AnyRecord,
  options: AnyRecord = {},
) {
  return options.all === true
    ? sessions
    : filterSessionNeighborhood(sessions, currentSession, options);
}

export function buildSessionTree(
  currentSession: AnyRecord | undefined,
  persistedSessions: AnyRecord[],
  runtimeSessions: PiRuntimeSession[] = listRuntimeSessions(),
  options: AnyRecord = {},
) {
  return orderSessionTree(
    mergeSessionSummaries([
      currentSession,
      ...persistedSessions.map((session) => summarizeSession(session, options)),
      ...runtimeSessions.map(runtimeSessionSummary),
    ]),
  );
}

export function sessionCompletionScope(
  sessions: AnyRecord[],
  currentSession: AnyRecord | undefined,
  options: AnyRecord = {},
) {
  const scoped = assignTreeDepths(
    sessionDiscoveryScope(sessions, currentSession ?? {}, options),
  ).map(withRuntimeState);

  return orderSessionCompletions(scoped, currentSession);
}

export function findSessionSummary(
  sessions: AnyRecord[],
  identity: AnyRecord = {},
) {
  const keys = sessionKeys(identity).filter(Boolean);

  if (keys.length === 0) return undefined;
  return sessions.find((session) =>
    sessionKeys(session).some((key) => keys.includes(key)),
  );
}

/** Keeps the current session plus nearby siblings and branch relatives. */
export function filterSessionNeighborhood(
  sessions,
  currentSession,
  { rx = 0, ry = 0 } = {},
) {
  if (!currentSession) return sessions;
  const currentKey = primarySessionKey(currentSession);
  const currentIndex = sessions.findIndex((session) =>
    sessionKeys(session).includes(currentKey),
  );
  const current = currentIndex === -1 ? undefined : sessions[currentIndex];

  if (!current) return sessions;
  const byKey = sessionKeyMap(sessions);
  const siblings = siblingGroups(sessions, byKey);
  const currentParentKey = parentSessionKey(current, byKey);
  const currentSiblings =
    siblings.get(siblingGroupKey(current, currentParentKey)) ?? [];
  const currentSiblingIndex = currentSiblings.indexOf(current);

  return sessions.filter((session) => {
    if (session === current) return true;
    const verticalDistance = Math.abs(
      Number(session.depth ?? 0) - Number(current.depth ?? 0),
    );

    if (verticalDistance > ry) return false;

    if (isAncestorOrDescendant(session, current, byKey)) return true;
    const parentKey = parentSessionKey(session, byKey);

    if (parentKey !== currentParentKey) return false;
    const group = siblings.get(siblingGroupKey(session, parentKey)) ?? [];
    const siblingIndex = group.indexOf(session);

    return (
      currentSiblingIndex !== -1 &&
      siblingIndex !== -1 &&
      Math.abs(siblingIndex - currentSiblingIndex) <= rx
    );
  });
}

export function orderSessionCompletions(
  sessions: AnyRecord[],
  currentSession: AnyRecord | undefined,
) {
  if (!currentSession) return sortSessions(sessions, modifiedTime);
  const byKey = sessionKeyMap(sessions);
  const currentKeys = sessionKeys(currentSession);
  const rank = (session: AnyRecord) => {
    const parentKey = parentSessionKey(session, byKey);

    return parentKey && currentKeys.includes(parentKey) ? 0 : 1;
  };

  return [...sessions].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      modifiedTime(b) - modifiedTime(a) ||
      sessionLabel(a).localeCompare(sessionLabel(b)),
  );
}

export function mergeSessionSummaries(sessions) {
  const byKey = new Map();

  for (const session of sessions.filter(Boolean)) {
    const key = session.path ?? session.sessionId ?? session.id;

    if (!key) continue;
    byKey.set(key, { ...(byKey.get(key) ?? {}), ...session });
  }

  return [...byKey.values()];
}

export function currentSessionSummary(ctx) {
  const sessionId = ctx.sessionManager.getSessionId?.();
  const path = ctx.sessionManager.getSessionFile?.();

  if (!sessionId && !path) return undefined;
  const state = getActiveState(ctx.sessionManager);

  return {
    id: sessionId,
    sessionId,
    shortId: sessionId ? shortSessionId(sessionId) : undefined,
    path,
    parentSessionPath: ctx.sessionManager.getHeader?.()?.parentSession,
    agentName: state.agentName,
    lastMessage: ctx.sessionManager.getSessionName?.() ?? "Current session",
    modified: new Date().toISOString(),
  };
}

export function runtimeSessionSummary(runtime) {
  const sessionId = runtime.session.sessionManager.getSessionId();

  return {
    id: sessionId,
    sessionId,
    shortId: shortSessionId(sessionId),
    path: runtime.session.sessionManager.getSessionFile(),
    parentSessionPath: runtime.parentSessionPath,
    agentName: runtime.agentName,
    lastMessage:
      runtime.lastMessage ??
      (runtime.agentName ? `Message to ${runtime.agentName}` : "Child session"),
    modified:
      runtime.lastActivityAt ?? runtime.createdAt ?? new Date().toISOString(),
  };
}

/** Adds live runtime details without changing persisted session summaries. */
export function withRuntimeState(session) {
  const runtime = findRuntimeSession(
    (item) => item.session.sessionManager.getSessionId() === session.sessionId,
  );

  if (!runtime) return session;
  const running = runtime.session?.isStreaming === true;
  const live =
    running && runtime.runtimeHost
      ? { livePath: livePath(runtime.session.sessionManager.getSessionId()) }
      : {};

  if (running && runtime.runtimeHost)
    registerLiveRuntime(runtime.runtimeHost, { agentName: runtime.agentName });

  const lastActivityAt = runtime.lastActivityAt ?? runtime.createdAt;
  const lastActivityTime = lastActivityAt
    ? new Date(lastActivityAt).getTime()
    : undefined;

  return {
    ...session,
    ...live,
    running,
    lastActivityAt,
    inactiveMs:
      lastActivityTime && Number.isFinite(lastActivityTime)
        ? Date.now() - lastActivityTime
        : session.inactiveMs,
    agentName: runtime.agentName ?? session.agentName,
  };
}

export function assignTreeDepths(sessions) {
  return sessions.map((session) => ({
    ...session,
    depth: Math.max(0, Number(session.depth ?? 0)),
    inactiveMs: session.modified
      ? Date.now() - new Date(session.modified).getTime()
      : 0,
  }));
}

function cachedPersistedSessionSummary(filePath: string, modified?: string): AnyRecord {
  if (!filePath) return {};

  try {
    const cacheKey = `${filePath}:${modified ?? statSync(filePath).mtimeMs}`;

    return persistedSummaryCache.get(cacheKey) ?? {};
  } catch {
    return {};
  }
}

function readPersistedSessionSummary(filePath: string, modified?: string): AnyRecord {
  if (!filePath) return {};

  try {
    const cacheKey = `${filePath}:${modified ?? statSync(filePath).mtimeMs}`;
    const cached = persistedSummaryCache.get(cacheKey);

    if (cached) return cached;
    const summary: AnyRecord = {};

    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);

      if (entry.type === "custom" && entry.customType === "pi-gentic:state") {
        summary.agentName =
          typeof entry.data?.agentName === "string" && entry.data.agentName
            ? entry.data.agentName
            : undefined;
      }

      if (entry.type === "message" && entry.message?.role === "user") {
        const text = extractText(entry.message.content);

        if (text) {
          summary.firstUserMessage ??= cleanSessionMessage(text);
          summary.lastUserMessage = cleanSessionMessage(text);
        }
      }
    }

    persistedSummaryCache.set(cacheKey, summary);
    prunePersistedSummaryCache();

    return summary;
  } catch {
    return {};
  }
}

function prunePersistedSummaryCache(maxEntries = 500) {
  if (persistedSummaryCache.size <= maxEntries) return;
  for (const key of persistedSummaryCache.keys()) {
    persistedSummaryCache.delete(key);

    if (persistedSummaryCache.size <= maxEntries) return;
  }
}

function extractText(content) {
  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return "";

  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n");
}

function cleanSessionMessage(text) {
  const match = String(text).match(
    /^Message from(?: \[[^\]]+\])? agent from session [^:]+:\n([\s\S]*?)(?:\nOnly your final answer will be returned\.)?$/,
  );

  return (match?.[1] ?? text).trim();
}

function isAncestorOrDescendant(a, b, byKey) {
  return isAncestor(a, b, byKey) || isAncestor(b, a, byKey);
}

function isAncestor(ancestor, session, byKey) {
  const ancestorKeys = new Set(sessionKeys(ancestor));
  let current = session;

  for (let guard = 0; guard < 100; guard++) {
    const parent = parentSession(current, byKey);

    if (!parent) return false;

    if (sessionKeys(parent).some((key) => ancestorKeys.has(key))) return true;
    current = parent;
  }

  return false;
}

function sessionKeyMap(sessions) {
  const byKey = new Map();

  for (const session of sessions)
    for (const key of sessionKeys(session)) byKey.set(key, session);

  return byKey;
}

function siblingGroups(sessions, byKey) {
  const groups = new Map();

  for (const session of sessions) {
    const key = siblingGroupKey(session, parentSessionKey(session, byKey));
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }

  return groups;
}

function siblingGroupKey(session, parentKey) {
  return `${parentKey ?? "root"}:${Number(session.depth ?? 0)}`;
}

function parentSession(session, byKey) {
  const key = parentSessionKey(session, byKey);

  return key ? byKey.get(key) : undefined;
}

function parentSessionKey(session, byKey) {
  return parentKeys(session).find((key) => byKey.has(key));
}

function primarySessionKey(session) {
  return (
    session.path ??
    session.sessionId ??
    session.id ??
    shortSessionId(session.sessionId ?? session.id)
  );
}

function sessionLabel(session) {
  return String(
    session.lastMessage ?? session.firstMessage ?? session.name ?? session.id ?? "",
  );
}

function sessionKeys(session) {
  return [
    session.path,
    session.sessionId,
    session.id,
    shortSessionId(session.sessionId ?? session.id),
    idFromPath(session.path),
  ].filter(Boolean);
}

function parentKeys(session) {
  return [
    session.parentSessionPath,
    session.parentSessionId,
    idFromPath(session.parentSessionPath),
    shortSessionId(session.parentSessionId),
  ].filter(Boolean);
}

function idFromPath(value) {
  const match = String(value ?? "").match(
    /([0-9a-f]{8,}(?:-[0-9a-f-]+)?)\.jsonl$/i,
  );

  return match?.[1];
}

function sortSessions(sessions, score = modifiedTime) {
  return [...sessions].sort(
    (a, b) =>
      score(b) - score(a) ||
      String(b.modified ?? "").localeCompare(String(a.modified ?? "")) ||
      String(b.path).localeCompare(String(a.path)),
  );
}

function modifiedTime(session) {
  const time = new Date(session.modified ?? 0).getTime();

  return Number.isFinite(time) ? time : 0;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = keyFn(item);

    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}
