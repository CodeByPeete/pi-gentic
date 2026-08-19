import { randomUUID } from "node:crypto";
import { Context, Effect, Fiber, FiberMap, Layer, Option, Schema, Semaphore } from "effect";
import { getLiveRuntimeState } from "../pi/runtime.js";
import type { HostRecord } from "../pi/types.js";
import { indexSessions } from "../sessions/catalog.js";
import { isRecord, normalizedPath, shortSessionId } from "../shared/values.js";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
export const DelegationId = NonEmptyString.pipe(Schema.brand("DelegationId"));
export type DelegationId = typeof DelegationId.Type;
type DelegationIdValue = DelegationId;

class DelegationAlreadyRegistered extends Schema.TaggedErrorClass<DelegationAlreadyRegistered>()(
  "DelegationAlreadyRegistered",
  { message: Schema.String, delegationId: DelegationId },
) {}

/** Process-wide delegation state shared by every extension runtime in the current Pi process. */
export type ActiveDelegation = {
  readonly id: DelegationIdValue;
  readonly callerSessionId?: string;
  readonly targetSessionId?: string;
  readonly enclosingDelegationIds: ReadonlySet<DelegationIdValue>;
  readonly abort?: (options?: Record<string, unknown>) => Promise<void> | void;
  readonly isCancellable?: () => boolean;
  readonly settlement: Promise<void>;
};

type RegisteredDelegation = ActiveDelegation & {
  readonly settle: () => void;
};

type DelegationRegistryState = {
  readonly active: Map<DelegationIdValue, RegisteredDelegation>;
};

export type RegisterActiveDelegation = Omit<ActiveDelegation, "enclosingDelegationIds" | "settlement"> & {
  readonly completionMode: "joined" | "detached";
};

declare global {
  var __piGenticDelegationRegistryStateV1: DelegationRegistryState | undefined;
}

function sharedState() {
  return (globalThis.__piGenticDelegationRegistryStateV1 ??= {
    active: new Map(),
  });
}

/** Creates the stable identity shared by execution, completion, cancellation, and presentation. */
export function createDelegationId() {
  return Schema.decodeUnknownSync(DelegationId)(`delegation:${randomUUID()}`);
}

/** Registers a delegation and captures the enclosing runs active when joined work begins. */
export function registerActiveDelegation(delegation: RegisterActiveDelegation) {
  const state = sharedState();

  if (state.active.has(delegation.id))
    throw DelegationAlreadyRegistered.make({
      message: `Delegation ${delegation.id} is already registered.`,
      delegationId: delegation.id,
    });
  const enclosingDelegationIds = new Set(
    delegation.completionMode === "joined" && delegation.callerSessionId
      ? [...state.active.values()].flatMap((candidate) =>
          candidate.targetSessionId === delegation.callerSessionId ? [candidate.id] : [],
        )
      : [],
  );
  const { promise: settlement, resolve: settle } = Promise.withResolvers<void>();
  const registered: RegisteredDelegation = {
    id: delegation.id,
    callerSessionId: delegation.callerSessionId,
    targetSessionId: delegation.targetSessionId,
    enclosingDelegationIds,
    abort: delegation.abort,
    isCancellable: delegation.isCancellable,
    settlement,
    settle,
  };

  state.active.set(registered.id, registered);
  return {
    id: registered.id,
    unregister: () => settleRegisteredDelegation(registered),
  };
}

function settleRegisteredDelegation(delegation: RegisteredDelegation) {
  const state = sharedState();

  if (state.active.get(delegation.id) !== delegation) return false;
  state.active.delete(delegation.id);
  delegation.settle();
  return true;
}

export function getActiveDelegation(delegationId: string): ActiveDelegation | undefined {
  if (!delegationId) return undefined;
  return sharedState().active.get(Schema.decodeUnknownSync(DelegationId)(delegationId));
}

export function listActiveDelegations(): ReadonlyArray<ActiveDelegation> {
  return [...sharedState().active.values()];
}

export function settleActiveDelegation(delegationId: DelegationIdValue) {
  const delegation = sharedState().active.get(delegationId);

  return delegation ? settleRegisteredDelegation(delegation) : false;
}

export const awaitJoinedDelegations = Effect.fn("DelegationRegistry.awaitJoined")(function* (
  enclosingDelegationId: DelegationIdValue,
) {
  const settlements = listActiveDelegations().flatMap((delegation) =>
    delegation.enclosingDelegationIds.has(enclosingDelegationId) ? [delegation.settlement] : [],
  );

  if (settlements.length > 0) yield* Effect.promise(() => Promise.all(settlements));
  return settlements.length;
});

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
  return isRecord(value) && value.sessions instanceof Set && value.calls instanceof Set;
}

export class DelegationFibers extends Context.Service<
  DelegationFibers,
  {
    readonly run: (delegationId: DelegationId, operation: Effect.Effect<void>) => Effect.Effect<Fiber.Fiber<void>>;
    readonly abort: (delegationId: DelegationId) => Effect.Effect<boolean>;
    readonly size: Effect.Effect<number>;
  }
>()("pi-gentic/DelegationFibers") {}

export const DelegationFibersLive = Layer.effect(
  DelegationFibers,
  Effect.gen(function* () {
    const fibers = yield* FiberMap.make<DelegationId, void, never>();
    const mutation = yield* Semaphore.make(1);

    return {
      run: Effect.fn("DelegationFibers.run")(function* (delegationId: DelegationId, operation: Effect.Effect<void>) {
        return yield* mutation.withPermit(
          Effect.gen(function* () {
            const existing = yield* FiberMap.get(fibers, delegationId);

            if (Option.isSome(existing)) return existing.value;
            return yield* FiberMap.run(fibers, delegationId, operation);
          }),
        );
      }),
      abort: Effect.fn("DelegationFibers.abort")(function* (delegationId: DelegationId) {
        return yield* mutation.withPermit(
          Effect.gen(function* () {
            const exists = yield* FiberMap.has(fibers, delegationId);

            if (exists) yield* FiberMap.remove(fibers, delegationId);
            return exists;
          }),
        );
      }),
      size: FiberMap.size(fibers),
    };
  }),
);
