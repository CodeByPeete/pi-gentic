import type { PiContext, PiRuntimeSession } from "../../infrastructure/pi/types.js";
import type { UnknownRecord } from "../../shared/types.js";
import { shortSessionId } from "../../shared/value.js";
import { getActiveState } from "../agents/state.js";
import {
  findRuntimeSession,
  listRuntimeSessions,
  livePath,
  registerLiveRuntime,
  runtimeSessionIsRunning,
} from "../../infrastructure/pi/host.js";
import {
  findSessionSummary,
  mergeSessionSummaries,
  orderSessionCompletions,
  orderSessionTree,
  sessionDiscoveryScope,
  summarizeSession,
} from "./model.js";

export function buildSessionTree(
  currentSession: UnknownRecord | undefined,
  persistedSessions: UnknownRecord[],
  runtimeSessions: PiRuntimeSession[] = listRuntimeSessions(),
  options: UnknownRecord = {},
) {
  return orderSessionTree(
    mergeSessionSummaries([
      currentSession,
      ...persistedSessions.map((session) => summarizeSession(session, options)),
      ...runtimeSessions.map(runtimeSessionSummary),
    ]),
  );
}

export function resolveCurrentSessionDepth(
  currentSession: UnknownRecord | undefined,
  persistedSessions: UnknownRecord[],
  runtimeSessions: PiRuntimeSession[] = listRuntimeSessions(),
) {
  if (!currentSession) return 0;
  const session = findSessionSummary(
    buildSessionTree(currentSession, persistedSessions, runtimeSessions),
    currentSession,
  );

  return Math.max(0, Number(session?.depth ?? 0));
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
