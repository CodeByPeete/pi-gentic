import { Context, Effect, Fiber, FiberMap, Layer, Option, Semaphore } from "effect";
import type { DelegationState } from "../../domain/delegation.js";
import type { DelegationId } from "../../domain/identifiers.js";

export class DelegationFibers extends Context.Service<
  DelegationFibers,
  {
    readonly run: (
      delegationId: DelegationId,
      operation: Effect.Effect<DelegationState>,
    ) => Effect.Effect<Fiber.Fiber<DelegationState>>;
    readonly abort: (delegationId: DelegationId) => Effect.Effect<boolean>;
    readonly size: Effect.Effect<number>;
  }
>()("pi-gentic/DelegationFibers") {}

export const DelegationFibersLive = Layer.effect(
  DelegationFibers,
  Effect.gen(function* () {
    const fibers = yield* FiberMap.make<DelegationId, DelegationState, never>();
    const mutation = yield* Semaphore.make(1);

    return {
      run: Effect.fn("DelegationFibers.run")(function* (
        delegationId: DelegationId,
        operation: Effect.Effect<DelegationState>,
      ) {
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
