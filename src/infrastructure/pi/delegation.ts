import path from "node:path";
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

export function hasAgentCallsForSession(sessionId: unknown) {
  return activeCallsForSession(sessionId).length > 0;
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
  const subtree = new Set<string>(rootSessionId ? [rootSessionId] : []);

  if (!rootSessionId) return subtree;
  const children = new Map<string, string[]>();
  const runtimes = [...getLiveRuntimeState().runtimeSessions.values()];
  const sessionIdsByPath = new Map(
    runtimes.flatMap((runtime) => {
      const id = runtime.session.sessionManager.getSessionId?.();
      const file = normalizeSessionPath(runtime.session.sessionManager.getSessionFile?.());

      return typeof id === "string" && file ? [[file, id]] : [];
    }),
  );

  for (const runtime of runtimes) {
    const id = runtime.session.sessionManager.getSessionId?.();
    const parentPath = runtime.parentSessionPath ?? runtime.session.sessionManager.getHeader?.()?.parentSession;
    const parentId = runtime.parentSessionId ?? sessionIdsByPath.get(normalizeSessionPath(parentPath) ?? "");

    if (typeof id !== "string" || typeof parentId !== "string") continue;
    children.set(parentId, [...(children.get(parentId) ?? []), id]);
  }

  const pending = [rootSessionId];

  while (pending.length > 0) {
    const parentId = pending.pop();

    if (!parentId) continue;
    for (const childId of children.get(parentId) ?? []) {
      if (subtree.has(childId)) continue;
      subtree.add(childId);
      pending.push(childId);
    }
  }

  return subtree;
}

function normalizeSessionPath(value: unknown) {
  if (typeof value !== "string" || !value) return undefined;
  const normalized = path.resolve(value);

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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
