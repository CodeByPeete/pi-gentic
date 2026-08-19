import type { UnknownRecord } from "../shared/types.js";
import { shortSessionId } from "../shared/value.js";

export function sessionIdFromPath(value: unknown) {
  return String(value ?? "").match(/([0-9a-f]{8,}(?:-[0-9a-f-]+)?)\.jsonl$/i)?.[1];
}

export function sessionKeys(session: UnknownRecord | undefined) {
  if (!session) return [];
  return [
    session.path,
    session.sessionId,
    session.id,
    shortSessionId(session.sessionId ?? session.id),
    sessionIdFromPath(session.path),
  ].filter((key): key is string => typeof key === "string" && key.length > 0);
}

export function parentSessionKeys(session: UnknownRecord) {
  return [
    session.parentSessionPath,
    session.parentSessionId,
    sessionIdFromPath(session.parentSessionPath),
    shortSessionId(session.parentSessionId),
  ].filter((key): key is string => typeof key === "string" && key.length > 0);
}

export function primarySessionKey(session: UnknownRecord) {
  return String(session.path ?? session.sessionId ?? session.id ?? shortSessionId(session.sessionId ?? session.id));
}

export function indexSessions(sessions: UnknownRecord[], normalize: (key: string) => string = (key) => key) {
  const byKey = new Map<string, UnknownRecord>();
  for (const session of sessions) for (const key of sessionKeys(session)) byKey.set(normalize(key), session);
  const parent = (session: UnknownRecord) => {
    const key = parentSessionKeys(session)
      .map(normalize)
      .find((candidate) => byKey.has(candidate));
    return key ? byKey.get(key) : undefined;
  };
  const find = (identity: UnknownRecord) => {
    const keys = new Set(sessionKeys(identity).map(normalize));
    return keys.size
      ? sessions.find((session) => sessionKeys(session).some((key) => keys.has(normalize(key))))
      : undefined;
  };
  const descendants = (identity: UnknownRecord) => {
    const keys = new Set(sessionKeys(identity).map(normalize));
    const result: UnknownRecord[] = [];

    for (let changed = true; changed; ) {
      changed = false;
      for (const session of sessions) {
        if (result.includes(session) || !parentSessionKeys(session).some((key) => keys.has(normalize(key)))) continue;
        result.push(session);
        for (const key of sessionKeys(session)) keys.add(normalize(key));
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
    const ancestorKeys = new Set(sessionKeys(ancestor).map(normalize));

    return lineage(session)
      .sessions.slice(1)
      .some((candidate) => sessionKeys(candidate).some((key) => ancestorKeys.has(normalize(key))));
  };

  return { byKey, descendants, find, isAncestor, lineage, parent };
}
