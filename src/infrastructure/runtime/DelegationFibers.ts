import { Context, Effect, Fiber, FiberMap, Layer, Option, Semaphore } from "effect";
import type { DelegationState } from "../../domain/delegation.js";
import type { DelegationId, SessionId } from "../../domain/identifiers.js";

type DelegationRunOptions = {
  readonly callerSessionId?: SessionId;
  readonly joinsCallerCompletion?: boolean;
};

export class DelegationFibers extends Context.Service<
  DelegationFibers,
  {
    readonly run: (
      delegationId: DelegationId,
      operation: Effect.Effect<DelegationState>,
      options?: DelegationRunOptions,
    ) => Effect.Effect<Fiber.Fiber<DelegationState>>;
    readonly abort: (delegationId: DelegationId) => Effect.Effect<boolean>;
    readonly awaitJoined: (callerSessionId: SessionId) => Effect.Effect<number>;
    readonly size: Effect.Effect<number>;
  }
>()("pi-gentic/DelegationFibers") {}

export const DelegationFibersLive = Layer.effect(
  DelegationFibers,
  Effect.gen(function* () {
    const fibers = yield* FiberMap.make<DelegationId, DelegationState, never>();
    const joinedCallers = new Map<DelegationId, SessionId>();
    const mutation = yield* Semaphore.make(1);
    const joinedFibers = (callerSessionId: SessionId) =>
      [...joinedCallers].flatMap(([delegationId, caller]) => {
        const fiber = FiberMap.getUnsafe(fibers, delegationId);

        return caller === callerSessionId && Option.isSome(fiber) ? [fiber.value] : [];
      });

    return {
      run: Effect.fn("DelegationFibers.run")(function* (
        delegationId: DelegationId,
        operation: Effect.Effect<DelegationState>,
        options: DelegationRunOptions = {},
      ) {
        return yield* mutation.withPermit(
          Effect.gen(function* () {
            const existing = yield* FiberMap.get(fibers, delegationId);

            if (Option.isSome(existing)) return existing.value;
            const callerSessionId = options.callerSessionId;

            if (options.joinsCallerCompletion === true && callerSessionId !== undefined)
              joinedCallers.set(delegationId, callerSessionId);
            return yield* FiberMap.run(
              fibers,
              delegationId,
              operation.pipe(Effect.ensuring(Effect.sync(() => joinedCallers.delete(delegationId)))),
            );
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
      awaitJoined: Effect.fn("DelegationFibers.awaitJoined")(function* (callerSessionId: SessionId) {
        const joined = joinedFibers(callerSessionId);

        yield* Effect.forEach(joined, Fiber.await, { concurrency: "unbounded" });
        return joined.length;
      }),
      size: FiberMap.size(fibers),
    };
  }),
);
