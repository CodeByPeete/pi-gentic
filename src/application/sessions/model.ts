import { readFileSync, statSync } from "node:fs";
import {
  indexSessions,
  parentSessionKeys,
  primarySessionKey,
  sessionIdFromPath,
  sessionKeys,
} from "../../domain/session.js";
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
  const graph = indexSessions(sessions);
  let current = graph.find(session) ?? session;

  for (let guard = 0; guard < 100; guard++) {
    const parent = graph.parent(current);

    if (!parent) {
      const unresolvedParentKey = parentSessionKeys(current)[0];

      return unresolvedParentKey
        ? {
            sessionId: sessionIdFromPath(unresolvedParentKey),
            path: unresolvedParentKey,
          }
        : current;
    }

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
  const unique = [...new Map(matches.map((session) => [session.path ?? session.id, session])).values()];

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
  const graph = indexSessions(sessions);
  const children = new Map<string, UnknownRecord[]>();
  const roots: UnknownRecord[] = [];

  for (const session of sessions) {
    const parent = graph.parent(session);

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
  return indexSessions(sessions).find(identity);
}

export function filterSessionNeighborhood(
  sessions: UnknownRecord[],
  currentSession: UnknownRecord,
  { rx = 0, ry = 0 } = {},
) {
  if (!currentSession) return sessions;
  const graph = indexSessions(sessions);
  const current = graph.find(currentSession);

  if (!current) return sessions;
  const siblings = siblingGroups(sessions, graph);
  const currentParentKey = parentSessionKey(current, graph);
  const currentSiblings = siblings.get(siblingGroupKey(current, currentParentKey)) ?? [];
  const currentSiblingIndex = currentSiblings.indexOf(current);

  return sessions.filter((session) => {
    if (session === current) return true;
    const verticalDistance = Math.abs(Number(session.depth ?? 0) - Number(current.depth ?? 0));

    if (verticalDistance > ry) return false;

    if (graph.isAncestor(session, current) || graph.isAncestor(current, session)) return true;
    const parentKey = parentSessionKey(session, graph);

    if (parentKey !== currentParentKey) return false;
    const group = siblings.get(siblingGroupKey(session, parentKey)) ?? [];
    const siblingIndex = group.indexOf(session);

    return currentSiblingIndex !== -1 && siblingIndex !== -1 && Math.abs(siblingIndex - currentSiblingIndex) <= rx;
  });
}

export function orderSessionCompletions(sessions: UnknownRecord[], currentSession: UnknownRecord | undefined) {
  if (!currentSession) return sortSessions(sessions, modifiedTime);
  const graph = indexSessions(sessions);
  const currentKeys = sessionKeys(currentSession);
  const rank = (session: UnknownRecord) => {
    const parentKey = parentSessionKey(session, graph);

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

function sameSessionIdentity(a: UnknownRecord | undefined, b: UnknownRecord | undefined) {
  const rightKeys = new Set(sessionKeys(b));

  return sessionKeys(a).some((key) => rightKeys.has(key));
}

function sessionDisplayId(session: UnknownRecord | undefined) {
  return (
    shortSessionId(session?.sessionId ?? session?.id) ||
    shortSessionId(sessionIdFromPath(session?.path)) ||
    shortSessionId(session?.path) ||
    "unknown"
  );
}

function siblingGroups(sessions: UnknownRecord[], graph: ReturnType<typeof indexSessions>) {
  const groups = new Map<string, UnknownRecord[]>();

  for (const session of sessions) {
    const key = siblingGroupKey(session, parentSessionKey(session, graph));
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }

  return groups;
}

function siblingGroupKey(session: UnknownRecord, parentKey: string | undefined) {
  return `${parentKey ?? "root"}:${Number(session.depth ?? 0)}`;
}

function parentSessionKey(session: UnknownRecord, graph: ReturnType<typeof indexSessions>) {
  const parent = graph.parent(session);
  return parent ? primarySessionKey(parent) : undefined;
}

function sessionLabel(session: UnknownRecord) {
  return String(session.lastMessage ?? session.firstMessage ?? session.name ?? session.id ?? "");
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
