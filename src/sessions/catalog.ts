import { readFileSync, statSync } from "node:fs";
import type { PiContext, PiRuntimeSession } from "../pi/types.js";
import { getActiveState } from "../agents/activation.js";
import {
  findRuntimeSession,
  listRuntimeSessions,
  livePath,
  registerLiveRuntime,
  runtimeSessionIsRunning,
} from "../pi/sessions.js";
import { reportRuntimeDiagnostic } from "../shared/diagnostics.js";
import type { UnknownRecord } from "../shared/values.js";
import { isRecord, omitUndefined, shortSessionId } from "../shared/values.js";

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
  const lineage = graph.lineage(session);
  const root = lineage.sessions.at(-1) ?? session;
  const unresolvedParent = !lineage.rooted && !graph.parent(root) ? parentSessionKeys(root)[0] : undefined;

  return unresolvedParent ? { sessionId: sessionIdFromPath(unresolvedParent), path: unresolvedParent } : root;
}

export function resolveSessionReference(sessions: UnknownRecord[], reference: unknown) {
  if (!reference) throw new Error("sessionId is required.");
  const query = String(reference).toLowerCase();
  const matches = sessions.filter((session) =>
    sessionReferenceKeys(session).some(
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
  const persisted = persistedSessionSummary(sessionPath, modified, options.enrich === true);

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

function orderSessionCompletions(sessions: UnknownRecord[], currentSession: UnknownRecord | undefined) {
  if (!currentSession) return sortSessions(sessions, modifiedTime);
  const graph = indexSessions(sessions);
  const currentKeys = sessionIdentityKeys(currentSession);
  const rank = (session: UnknownRecord) => {
    const parentKey = parentSessionKey(session, graph);

    return parentKey && currentKeys.includes(parentKey) ? 0 : 1;
  };

  return [...sessions].sort(
    (a, b) => rank(a) - rank(b) || modifiedTime(b) - modifiedTime(a) || sessionLabel(a).localeCompare(sessionLabel(b)),
  );
}

function mergeSessionSummaries(sessions: unknown[]) {
  const byKey = new Map<string, UnknownRecord>();

  for (const session of sessions.filter(isRecord)) {
    const key = sessionIdentityKeys(session)[0];

    if (key) byKey.set(key, { ...byKey.get(key), ...omitUndefined({ ...session }) });
  }

  return [...byKey.values()];
}
function persistedSessionSummary(
  filePath: string,
  modified: string | number | undefined,
  read: boolean,
): UnknownRecord {
  if (!filePath) return {};

  try {
    const cacheKey = `${filePath}:${modified ?? statSync(filePath).mtimeMs}`;
    const cached = persistedSummaryCache.get(cacheKey);

    if (cached || !read) return cached ?? {};
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
    reportRuntimeDiagnostic(read ? "session-summary-read" : "session-summary-cache", error);
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
  const rightKeys = new Set(sessionIdentityKeys(b));

  return sessionIdentityKeys(a).some((key) => rightKeys.has(key));
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

function sessionIdFromPath(value: unknown) {
  return String(value ?? "").match(/([0-9a-f]{8,}(?:-[0-9a-f-]+)?)\.jsonl$/i)?.[1];
}

function sessionIdentityKeys(session: UnknownRecord | undefined) {
  if (!session) return [];

  return [session.path, session.sessionId, session.id, sessionIdFromPath(session.path)].filter(
    (key): key is string => typeof key === "string" && key.length > 0,
  );
}

function sessionReferenceKeys(session: UnknownRecord) {
  const shortId = shortSessionId(session.sessionId ?? session.id);

  return shortId ? [...sessionIdentityKeys(session), shortId] : sessionIdentityKeys(session);
}

function parentSessionKeys(session: UnknownRecord) {
  return [session.parentSessionPath, session.parentSessionId, sessionIdFromPath(session.parentSessionPath)].filter(
    (key): key is string => typeof key === "string" && key.length > 0,
  );
}

function primarySessionKey(session: UnknownRecord) {
  return sessionIdentityKeys(session)[0] ?? "";
}

export function indexSessions(sessions: UnknownRecord[], normalize: (key: string) => string = (key) => key) {
  const byKey = new Map<string, UnknownRecord>();

  for (const session of sessions)
    for (const key of sessionIdentityKeys(session)) byKey.set(normalize(key), session);
  const parent = (session: UnknownRecord) => {
    const key = parentSessionKeys(session)
      .map(normalize)
      .find((candidate) => byKey.has(candidate));
    return key ? byKey.get(key) : undefined;
  };
  const find = (identity: UnknownRecord) => {
    const key = sessionIdentityKeys(identity)
      .map(normalize)
      .find((candidate) => byKey.has(candidate));

    return key ? byKey.get(key) : undefined;
  };
  const descendants = (identity: UnknownRecord) => {
    const keys = new Set(sessionIdentityKeys(identity).map(normalize));
    const result: UnknownRecord[] = [];

    for (let changed = true; changed; ) {
      changed = false;
      for (const session of sessions) {
        if (result.includes(session) || !parentSessionKeys(session).some((key) => keys.has(normalize(key)))) continue;
        result.push(session);
        for (const key of sessionIdentityKeys(session)) keys.add(normalize(key));
        changed = true;
      }
    }
    return result;
  };
  const lineage = (identity: UnknownRecord) => {
    const path = new Set<UnknownRecord>();

    for (let current = find(identity); current && !path.has(current); current = parent(current)) {
      path.add(current);
      if (parentSessionKeys(current).length === 0) return { sessions: [...path], rooted: true };
    }
    return { sessions: [...path], rooted: false };
  };
  const isAncestor = (ancestor: UnknownRecord, session: UnknownRecord) => {
    const ancestorKeys = new Set(sessionIdentityKeys(ancestor).map(normalize));

    return lineage(session)
      .sessions.slice(1)
      .some((candidate) => sessionIdentityKeys(candidate).some((key) => ancestorKeys.has(normalize(key))));
  };

  return { byKey, descendants, find, isAncestor, lineage, parent };
}

export function buildSessionTree(
  currentSession: UnknownRecord | undefined,
  persistedSessions: UnknownRecord[],
  runtimeSessions: PiRuntimeSession[] = listRuntimeSessions(),
  options: UnknownRecord = {},
) {
  return orderSessionTree(sessionSummaries(currentSession, persistedSessions, runtimeSessions, options));
}

export function resolveRootedSessionDepth(
  currentSession: UnknownRecord | undefined,
  persistedSessions: UnknownRecord[],
  runtimeSessions: PiRuntimeSession[] = listRuntimeSessions(),
) {
  if (!currentSession) throw new Error("Cannot determine session depth without a complete session lineage.");
  const lineage = indexSessions(sessionSummaries(currentSession, persistedSessions, runtimeSessions)).lineage(
    currentSession,
  );

  if (!lineage.rooted) throw new Error("Cannot determine session depth without a complete session lineage.");
  return lineage.sessions.length - 1;
}

function sessionSummaries(
  currentSession: UnknownRecord | undefined,
  persistedSessions: UnknownRecord[],
  runtimeSessions: PiRuntimeSession[],
  options: UnknownRecord = {},
) {
  return mergeSessionSummaries([
    currentSession,
    ...persistedSessions.map((session) => summarizeSession(session, options)),
    ...runtimeSessions.map(runtimeSessionSummary),
  ]);
}

export function sessionCompletionScope(
  sessions: UnknownRecord[],
  currentSession: UnknownRecord | undefined,
  options: UnknownRecord = {},
) {
  const scoped = assignTreeDepths(sessionDiscoveryScope(sessions, currentSession ?? {}, options)).map(withRuntimeState);

  return orderSessionCompletions(scoped, currentSession);
}

export function currentSessionSummary(ctx: PiContext) {
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

export function runtimeSessionSummary(runtime: PiRuntimeSession) {
  const sessionId = runtime.session.sessionManager.getSessionId();

  return {
    id: sessionId,
    sessionId,
    shortId: shortSessionId(sessionId),
    path: runtime.session.sessionManager.getSessionFile(),
    parentSessionId: runtime.parentSessionId,
    parentSessionPath: runtime.parentSessionPath,
    agentName: runtime.agentName,
    lastMessage: runtime.lastMessage ?? (runtime.agentName ? `Message to ${runtime.agentName}` : "Child session"),
    modified: runtime.lastActivityAt ?? runtime.createdAt ?? new Date().toISOString(),
  };
}

export function withRuntimeState(session: UnknownRecord) {
  const runtime = findRuntimeSession((item) => item.session.sessionManager.getSessionId() === session.sessionId);

  if (!runtime) return session;
  const running = runtimeSessionIsRunning(runtime);
  const live =
    running && runtime.runtimeHost ? { livePath: livePath(runtime.session.sessionManager.getSessionId()) } : {};

  if (running && runtime.runtimeHost) registerLiveRuntime(runtime.runtimeHost, { agentName: runtime.agentName });

  const lastActivityAt = runtime.lastActivityAt ?? runtime.createdAt;
  const lastActivityTime = lastActivityAt ? new Date(lastActivityAt).getTime() : undefined;

  return {
    ...session,
    ...live,
    running,
    lastActivityAt,
    inactiveMs:
      lastActivityTime && Number.isFinite(lastActivityTime) ? Date.now() - lastActivityTime : session.inactiveMs,
    agentName: runtime.agentName ?? session.agentName,
  };
}

export function assignTreeDepths(sessions: UnknownRecord[]) {
  return sessions.map((session) => ({
    ...session,
    depth: Math.max(0, Number(session.depth ?? 0)),
    inactiveMs:
      typeof session.modified === "string" || typeof session.modified === "number"
        ? Date.now() - new Date(session.modified).getTime()
        : 0,
  }));
}
