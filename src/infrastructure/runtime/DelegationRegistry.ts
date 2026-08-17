import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { DelegationAlreadyRegistered } from "../../domain/errors.js";
import { DelegationId, type DelegationId as DelegationIdValue } from "../../domain/identifiers.js";

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

export function activeDelegationMap(): ReadonlyMap<DelegationIdValue, ActiveDelegation> {
  return sharedState().active;
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
