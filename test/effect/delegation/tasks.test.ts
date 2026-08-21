import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { DelegationFibers, DelegationFibersLive, DelegationId } from "../../../src/delegation/runs.js";

const delegationId = Schema.decodeUnknownSync(DelegationId);

describe("DelegationFibers", () => {
  it.layer(DelegationFibersLive)((it) => {
    it.effect("owns each delegation by stable identity and interrupts it", () =>
      Effect.gen(function* () {
        const delegations = yield* DelegationFibers;
        const identity = delegationId("delegation-1");
        const first = yield* delegations.run(identity, Effect.never);
        const duplicate = yield* delegations.run(identity, Effect.never);

        assert.strictEqual(first, duplicate);
        assert.strictEqual(yield* delegations.size, 1);
        assert.isTrue(yield* delegations.abort(identity));
        const exit = yield* Fiber.await(first);

        assert.strictEqual(exit._tag, "Failure");
        assert.strictEqual(yield* delegations.size, 0);
        assert.isFalse(yield* delegations.abort(delegationId("missing")));
      }),
    );

    it.effect("supervises high-volume concurrent delegations without identity collisions", () =>
      Effect.gen(function* () {
        const delegations = yield* DelegationFibers;
        const identities = Array.from({ length: 100 }, (_, index) => delegationId(`delegation-${index}`));
        const fibers = yield* Effect.forEach(identities, (identity) => delegations.run(identity, Effect.never), {
          concurrency: "unbounded",
        });

        assert.strictEqual(yield* delegations.size, identities.length);
        const aborted = yield* Effect.forEach(identities, delegations.abort, { concurrency: "unbounded" });
        const exits = yield* Effect.forEach(fibers, Fiber.await, { concurrency: "unbounded" });

        assert.isTrue(aborted.every(Boolean));
        assert.isTrue(exits.every((exit) => exit._tag === "Failure"));
        assert.strictEqual(yield* delegations.size, 0);
      }),
    );
  });
});
