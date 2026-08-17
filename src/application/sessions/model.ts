import { readFileSync, statSync } from "node:fs";
import { reportRuntimeDiagnostic } from "../../shared/diagnostics.js";
import type { UnknownRecord } from "../../shared/types.js";
import { isRecord, shortSessionId } from "../../shared/value.js";

const persistedSummaryCache = new Map();
const PERSISTED_SUMMARY_CACHE_CAPACITY = 4_096;

export function assertDifferentSession(callerSessionId: unknown, targetSessionId: unknown) {
  if (!callerSessionId || !targetSessionId || callerSessionId !== targetSessionId) return;

  throw new Error(
    `Cannot send a message to the current session ${shortSessionId(callerSessionId)}. Choose a different sessionId or omit sessionId to create a child session.`,
  );
}

export function assertSessionMessagingScope(
  callerSession: UnknownRecord | undefined,
  targetSession: UnknownRecord | undefined,
  sessions: UnknownRecord[],
  options: UnknownRecord = {},
) {
  if (options.scope === "all") return;
  const tree = mergeSessionSummaries([...sessions, callerSession, targetSession]);
  const callerRoot = sessionTreeRoot(callerSession, tree);
  const targetRoot = sessionTreeRoot(targetSession, tree);

  if (callerRoot && targetRoot && sameSessionIdentity(callerRoot, targetRoot)) return;

  throw new Error(
    `Cannot send a message to session ${sessionDisplayId(targetSession)} because it belongs to a different session tree. Caller root: ${sessionDisplayId(callerRoot)}. Target root: ${sessionDisplayId(targetRoot)}.`,
  );
}

function sessionTreeRoot(session: UnknownRecord | undefined, sessions: UnknownRecord[]) {
  if (!session) return undefined;
  const byKey = sessionKeyMap(sessions);
  let current = findSessionSummary(sessions, session) ?? session;

  for (let guard = 0; guard < 100; guard++) {
    const parentKey = parentKeys(current).find((key) => byKey.has(key));

    if (!parentKey) {
      const unresolvedParentKey = parentKeys(current)[0];

      return unresolvedParentKey
        ? {
            sessionId: idFromPath(unresolvedParentKey),
            path: unresolvedParentKey,
          }
        : current;
    }

    const parent = byKey.get(parentKey);
    if (!parent) return current;
    current = parent;
  }

  return current;
}

export function resolveSessionReference(sessions: UnknownRecord[], reference: unknown) {
  if (!reference) throw new Error("sessionId is required.");
  const query = String(reference).toLowerCase();
  const matches = sessions.filter((session) =>
    sessionKeys(session).some(
      (key) => String(key).toLowerCase() === query || String(key).toLowerCase().includes(query),
    ),
  );
  const unique = uniqueBy(matches, (session) => session.path ?? session.id);

  if (unique.length === 0) throw new Error(`No session matches "${reference}".`);

  if (unique.length > 1)
    throw new Error(`Ambiguous session reference "${reference}" matches ${unique.length} sessions.`);

  return unique[0];
}

export function summarizeSession(session: UnknownRecord, options: UnknownRecord = {}) {
  const sessionPath = typeof session.path === "string" ? session.path : "";
  const modified =
    session.modified instanceof Date
      ? session.modified.getTime()
      : typeof session.modified === "string" || typeof session.modified === "number"
        ? session.modified
        : undefined;
  const persisted =
    options.enrich === true
      ? readPersistedSessionSummary(sessionPath, modified)
      : cachedPersistedSessionSummary(sessionPath, modified);

  return {
    id: session.id,
    sessionId: session.id,
    shortId: shortSessionId(session.id),
    path: session.path,
    parentSessionPath: session.parentSessionPath,
    name: session.name,
    firstMessage: persisted.firstUserMessage ?? session.firstMessage,
    lastMessage: persisted.lastUserMessage ?? session.lastMessage ?? session.name ?? session.firstMessage,
    modified: session.modified,
    agentName: persisted.agentName ?? session.agentName,
  };
}

export function enrichSessionSummary(session: UnknownRecord) {
  return session?.path ? { ...session, ...summarizeSession(session, { enrich: true }) } : session;
}

export function enrichSessionSummaries(sessions: UnknownRecord[], limit = sessions.length) {
  return sessions.map((session, index) => (index < limit ? enrichSessionSummary(session) : session));
}

export function orderSessionTree(sessions: UnknownRecord[]) {
  const byKey = sessionKeyMap(sessions);
  const children = new Map<string, UnknownRecord[]>();
  const roots: UnknownRecord[] = [];

  for (const session of sessions) {
    const parent = parentSession(session, byKey);

    if (!parent) roots.push(session);
    else {
      const parentKey = primarySessionKey(parent);
      children.set(parentKey, [...(children.get(parentKey) ?? []), session]);
    }
  }

  const activity = new Map<string, number>();
  const subtreeModified = (session: UnknownRecord, visiting = new Set<string>()): number => {
    const key = primarySessionKey(session);
    const cached = activity.get(key);

    if (cached !== undefined) return cached;
    if (visiting.has(key)) return modifiedTime(session);
    const nestedVisiting = new Set(visiting).add(key);
    const value = Math.max(
      modifiedTime(session),
      ...(children.get(key) ?? []).map((child) => subtreeModified(child, nestedVisiting)),
    );
    activity.set(key, value);
    return value;
  };
  const sortByTreeActivity = (items: UnknownRecord[]) => sortSessions(items, subtreeModified);
  const ordered: UnknownRecord[] = [];
  const visited = new Set<string>();
  const visit = (session: UnknownRecord, depth = 0, siblingIndex = 0, siblingCount = 1) => {
    const key = primarySessionKey(session);

    if (visited.has(key)) return;
    visited.add(key);
    const nested = sortByTreeActivity(children.get(key) ?? []);
    ordered.push({
      ...session,
      depth,
      isLast: siblingIndex === siblingCount - 1,
    });
    nested.forEach((child, index) => visit(child, depth + 1, index, nested.length));
  };

  const sortedRoots = sortByTreeActivity(roots);
  sortedRoots.forEach((root, index) => visit(root, 0, index, sortedRoots.length));
  const cyclicOrphans = sortByTreeActivity(sessions.filter((session) => !visited.has(primarySessionKey(session))));
  cyclicOrphans.forEach((session, index) => visit(session, 0, index, cyclicOrphans.length));

  return ordered;
}

export function treeSwitchPath(session: UnknownRecord) {
  return session.running === true ? (session.livePath ?? session.path) : (session.path ?? session.livePath);
}

export function sessionDiscoveryScope(
  sessions: UnknownRecord[],
  currentSession: UnknownRecord,
  options: UnknownRecord = {},
) {
  return options.all === true ? sessions : filterSessionNeighborhood(sessions, currentSession, options);
}
export function findSessionSummary(sessions: UnknownRecord[], identity: UnknownRecord = {}) {
  const keys = sessionKeys(identity).filter(Boolean);

  if (keys.length === 0) return undefined;
  return sessions.find((session) => sessionKeys(session).some((key) => keys.includes(key)));
}

export function filterSessionNeighborhood(
  sessions: UnknownRecord[],
  currentSession: UnknownRecord,
  { rx = 0, ry = 0 } = {},
) {
  if (!currentSession) return sessions;
  const currentKey = primarySessionKey(currentSession);
  const currentIndex = sessions.findIndex((session) => sessionKeys(session).includes(currentKey));
  const current = currentIndex === -1 ? undefined : sessions[currentIndex];

  if (!current) return sessions;
  const byKey = sessionKeyMap(sessions);
  const siblings = siblingGroups(sessions, byKey);
  const currentParentKey = parentSessionKey(current, byKey);
  const currentSiblings = siblings.get(siblingGroupKey(current, currentParentKey)) ?? [];
  const currentSiblingIndex = currentSiblings.indexOf(current);

  return sessions.filter((session) => {
    if (session === current) return true;
    const verticalDistance = Math.abs(Number(session.depth ?? 0) - Number(current.depth ?? 0));

    if (verticalDistance > ry) return false;

    if (isAncestorOrDescendant(session, current, byKey)) return true;
    const parentKey = parentSessionKey(session, byKey);

    if (parentKey !== currentParentKey) return false;
    const group = siblings.get(siblingGroupKey(session, parentKey)) ?? [];
    const siblingIndex = group.indexOf(session);

    return currentSiblingIndex !== -1 && siblingIndex !== -1 && Math.abs(siblingIndex - currentSiblingIndex) <= rx;
  });
}

export function orderSessionCompletions(sessions: UnknownRecord[], currentSession: UnknownRecord | undefined) {
  if (!currentSession) return sortSessions(sessions, modifiedTime);
  const byKey = sessionKeyMap(sessions);
  const currentKeys = sessionKeys(currentSession);
  const rank = (session: UnknownRecord) => {
    const parentKey = parentSessionKey(session, byKey);

    return parentKey && currentKeys.includes(parentKey) ? 0 : 1;
  };

  return [...sessions].sort(
    (a, b) => rank(a) - rank(b) || modifiedTime(b) - modifiedTime(a) || sessionLabel(a).localeCompare(sessionLabel(b)),
  );
}

export function mergeSessionSummaries(sessions: unknown[]) {
  const byKey = new Map<string, UnknownRecord>();

  for (const session of sessions.filter(isRecord)) {
    const key = session.path ?? session.sessionId ?? session.id;

    if (typeof key !== "string" || !key) continue;
    byKey.set(key, { ...byKey.get(key), ...session });
  }

  return [...byKey.values()];
}
function cachedPersistedSessionSummary(filePath: string, modified?: string | number): UnknownRecord {
  if (!filePath) return {};

  try {
    const cacheKey = `${filePath}:${modified ?? statSync(filePath).mtimeMs}`;

    return persistedSummaryCache.get(cacheKey) ?? {};
  } catch (error) {
    reportRuntimeDiagnostic("session-summary-cache", error);
    return {};
  }
}

function readPersistedSessionSummary(filePath: string, modified?: string | number): UnknownRecord {
  if (!filePath) return {};

  try {
    const cacheKey = `${filePath}:${modified ?? statSync(filePath).mtimeMs}`;
    const cached = persistedSummaryCache.get(cacheKey);

    if (cached) return cached;
    const summary: UnknownRecord = {};

    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);

      if (entry.type === "custom" && entry.customType === "pi-gentic:state") {
        summary.agentName =
          typeof entry.data?.agentName === "string" && entry.data.agentName ? entry.data.agentName : undefined;
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
  } catch (error) {
    reportRuntimeDiagnostic("session-summary-read", error);
    return {};
  }
}

function prunePersistedSummaryCache(maxEntries = PERSISTED_SUMMARY_CACHE_CAPACITY) {
  if (persistedSummaryCache.size <= maxEntries) return;
  for (const key of persistedSummaryCache.keys()) {
    persistedSummaryCache.delete(key);

    if (persistedSummaryCache.size <= maxEntries) return;
  }
}

function extractText(content: unknown) {
  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return "";

  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n");
}

function cleanSessionMessage(text: string) {
  const match = String(text).match(
    /^Message from(?: \[[^\]]+\])? agent from session [^:]+:\n([\s\S]*?)(?:\nOnly your final answer will be returned\.)?$/,
  );

  return (match?.[1] ?? text).trim();
}

function isAncestorOrDescendant(a: UnknownRecord, b: UnknownRecord, byKey: Map<string, UnknownRecord>) {
  return isAncestor(a, b, byKey) || isAncestor(b, a, byKey);
}

function sameSessionIdentity(a: UnknownRecord | undefined, b: UnknownRecord | undefined) {
  const rightKeys = new Set(sessionKeys(b));

  return sessionKeys(a).some((key) => rightKeys.has(key));
}

function sessionDisplayId(session: UnknownRecord | undefined) {
  return (
    shortSessionId(session?.sessionId ?? session?.id) ||
    shortSessionId(idFromPath(session?.path)) ||
    shortSessionId(session?.path) ||
    "unknown"
  );
}

function isAncestor(ancestor: UnknownRecord, session: UnknownRecord, byKey: Map<string, UnknownRecord>) {
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

function sessionKeyMap(sessions: UnknownRecord[]) {
  const byKey = new Map<string, UnknownRecord>();

  for (const session of sessions) for (const key of sessionKeys(session)) byKey.set(key, session);

  return byKey;
}

function siblingGroups(sessions: UnknownRecord[], byKey: Map<string, UnknownRecord>) {
  const groups = new Map<string, UnknownRecord[]>();

  for (const session of sessions) {
    const key = siblingGroupKey(session, parentSessionKey(session, byKey));
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }

  return groups;
}

function siblingGroupKey(session: UnknownRecord, parentKey: string | undefined) {
  return `${parentKey ?? "root"}:${Number(session.depth ?? 0)}`;
}

function parentSession(session: UnknownRecord, byKey: Map<string, UnknownRecord>) {
  const key = parentSessionKey(session, byKey);

  return key ? byKey.get(key) : undefined;
}

function parentSessionKey(session: UnknownRecord, byKey: Map<string, UnknownRecord>) {
  return parentKeys(session).find((key) => byKey.has(key));
}

function primarySessionKey(session: UnknownRecord) {
  return String(session.path ?? session.sessionId ?? session.id ?? shortSessionId(session.sessionId ?? session.id));
}

function sessionLabel(session: UnknownRecord) {
  return String(session.lastMessage ?? session.firstMessage ?? session.name ?? session.id ?? "");
}

function sessionKeys(session: UnknownRecord | undefined) {
  if (!session) return [];

  return [
    session.path,
    session.sessionId,
    session.id,
    shortSessionId(session.sessionId ?? session.id),
    idFromPath(session.path),
  ].filter((key): key is string => typeof key === "string" && key.length > 0);
}

function parentKeys(session: UnknownRecord) {
  return [
    session.parentSessionPath,
    session.parentSessionId,
    idFromPath(session.parentSessionPath),
    shortSessionId(session.parentSessionId),
  ].filter((key): key is string => typeof key === "string" && key.length > 0);
}

function idFromPath(value: unknown) {
  const match = String(value ?? "").match(/([0-9a-f]{8,}(?:-[0-9a-f-]+)?)\.jsonl$/i);

  return match?.[1];
}

function sortSessions(sessions: UnknownRecord[], score: (session: UnknownRecord) => number = modifiedTime) {
  return [...sessions].sort(
    (a, b) =>
      score(b) - score(a) ||
      String(b.modified ?? "").localeCompare(String(a.modified ?? "")) ||
      String(b.path).localeCompare(String(a.path)),
  );
}

export function modifiedTime(session: UnknownRecord) {
  const time =
    session.modified instanceof Date
      ? session.modified.getTime()
      : new Date(
          typeof session.modified === "string" || typeof session.modified === "number" ? session.modified : 0,
        ).getTime();

  return Number.isFinite(time) ? time : 0;
}

function uniqueBy<T>(items: T[], keyFn: (item: T) => unknown) {
  const seen = new Set<unknown>();
  const result: T[] = [];

  for (const item of items) {
    const key = keyFn(item);

    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}
