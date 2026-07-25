import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import {
  DelegationFibers,
  DelegationFibersLive,
} from "../src/infrastructure/runtime/DelegationFibers.js";

describe("DelegationFibers", () => {
  it.layer(DelegationFibersLive)((it) => {
    it.effect("owns each delegation by stable identity and interrupts it", () =>
      Effect.gen(function* () {
        const delegations = yield* DelegationFibers;
        const first = yield* delegations.run("delegation-1", Effect.never);
        const duplicate = yield* delegations.run(
          "delegation-1",
          Effect.never,
        );

        assert.strictEqual(first, duplicate);
        assert.strictEqual(yield* delegations.size, 1);
        assert.isTrue(yield* delegations.abort("delegation-1"));
        const exit = yield* Fiber.await(first);

        assert.strictEqual(exit._tag, "Failure");
        assert.strictEqual(yield* delegations.size, 0);
        assert.isFalse(yield* delegations.abort("missing"));
      }),
    );
  });
});
