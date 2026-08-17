import { indexSessions } from "../../domain/session.js";
import { normalizedPath } from "../../shared/path.js";
import { shortSessionId } from "../../shared/value.js";
import type { DelegationId } from "../../domain/identifiers.js";
import {
  createDelegationId,
  getActiveDelegation,
  listActiveDelegations,
  registerActiveDelegation,
  settleActiveDelegation,
  type ActiveDelegation,
  type RegisterActiveDelegation,
} from "../runtime/DelegationRegistry.js";
import { getLiveRuntimeState, type HostRecord } from "./state.js";

type AbortState = {
  sessions: Set<unknown>;
  calls: Set<unknown>;
};

type RegisterAgentCall = Omit<RegisterActiveDelegation, "id" | "completionMode"> & {
  readonly id?: DelegationId;
  readonly completionMode?: RegisterActiveDelegation["completionMode"];
};

export function registerAgentCall(call: RegisterAgentCall) {
  const { id = createDelegationId(), completionMode = "detached", ...delegation } = call;

  return registerActiveDelegation({ ...delegation, id, completionMode });
}

export function assertNoAgentCallCycle(callerSessionId: unknown, targetSessionId: unknown) {
  const caller = String(callerSessionId ?? "");
  const target = String(targetSessionId ?? "");

  if (!caller || !target) return;
  const targetsByCaller = new Map<string, Set<string>>();

  for (const call of listActiveDelegations()) {
    if (!call.callerSessionId || !call.targetSessionId) continue;
    const targets = targetsByCaller.get(call.callerSessionId) ?? new Set<string>();

    targets.add(call.targetSessionId);
    targetsByCaller.set(call.callerSessionId, targets);
  }

  const pending = [target];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const sessionId = pending.pop();

    if (!sessionId || visited.has(sessionId)) continue;
    if (sessionId === caller)
      throw new Error(
        `Cannot send from session ${shortSessionId(caller)} to session ${shortSessionId(target)} because it would create an active delegation cycle. Wait for the active request to finish before messaging that session.`,
      );
    visited.add(sessionId);
    pending.push(...(targetsByCaller.get(sessionId) ?? []));
  }
}

export function hasCancellableAgentCallsForSession(sessionId: unknown) {
  return activeCallsForSession(sessionId).some((call) => call.isCancellable?.() !== false);
}

export async function abortAgentCall(callId: string, options: HostRecord = {}) {
  const call = getActiveDelegation(callId);

  return abortCalls(call ? [call] : [], options);
}

export async function abortAgentCallsForSession(sessionId: unknown, options: HostRecord = {}) {
  return abortCalls(activeCallsForSession(sessionId), options);
}

function activeCallsForSession(sessionId: unknown) {
  const sessionIds = sessionSubtreeIds(sessionId);

  return listActiveDelegations().filter(
    (call) =>
      (call.callerSessionId !== undefined && sessionIds.has(call.callerSessionId)) ||
      (call.targetSessionId !== undefined && sessionIds.has(call.targetSessionId)),
  );
}

function sessionSubtreeIds(sessionId: unknown) {
  const rootSessionId = String(sessionId ?? "");
  const runtimes = [...getLiveRuntimeState().runtimeSessions.values()];
  const idsByPath = new Map(
    runtimes.map((runtime) => [
      normalizedPath(runtime.session.sessionManager.getSessionFile?.()),
      runtime.session.sessionManager.getSessionId?.(),
    ]),
  );
  const sessions = runtimes.map((runtime) => {
    const parentPath = runtime.parentSessionPath ?? runtime.session.sessionManager.getHeader?.()?.parentSession;
    return {
      sessionId: runtime.session.sessionManager.getSessionId?.(),
      path: normalizedPath(runtime.session.sessionManager.getSessionFile?.()),
      parentSessionId: runtime.parentSessionId ?? idsByPath.get(normalizedPath(parentPath)),
      parentSessionPath: normalizedPath(parentPath),
    };
  });

  return new Set([
    ...(rootSessionId ? [rootSessionId] : []),
    ...indexSessions(sessions)
      .descendants({ sessionId: rootSessionId })
      .map((session) => String(session.sessionId)),
  ]);
}

async function abortCalls(calls: ReadonlyArray<ActiveDelegation>, options: HostRecord = {}) {
  const state = isAbortState(options.state) ? options.state : { sessions: new Set(), calls: new Set() };
  let aborted = 0;

  for (const call of calls) {
    if (!call || state.calls.has(call.id)) continue;
    state.calls.add(call.id);

    try {
      if (call.targetSessionId && !state.sessions.has(call.targetSessionId)) {
        state.sessions.add(call.targetSessionId);
        aborted += await abortAgentCallsForSession(call.targetSessionId, {
          ...options,
          state,
        });
      }

      if (typeof call.abort === "function") {
        await call.abort(options);
        aborted += 1;
      }
    } finally {
      settleActiveDelegation(call.id);
    }
  }

  return aborted;
}

function isAbortState(value: unknown): value is AbortState {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { sessions?: unknown }).sessions instanceof Set &&
    (value as { calls?: unknown }).calls instanceof Set
  );
}
