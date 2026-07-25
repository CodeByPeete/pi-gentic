import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import type { DelegationState } from "../src/domain/delegation.js";
import { DelegationFibers } from "../src/infrastructure/runtime/DelegationFibers.js";
import {
  createExtensionRuntime,
  shouldDisposeExtensionRuntime,
} from "../src/runtime/ExtensionRuntime.js";

describe("ExtensionRuntime", () => {
  it("survives native session replacement and closes at host shutdown", () => {
    assert.isFalse(shouldDisposeExtensionRuntime("new"));
    assert.isFalse(shouldDisposeExtensionRuntime("resume"));
    assert.isFalse(shouldDisposeExtensionRuntime("fork"));
    assert.isTrue(shouldDisposeExtensionRuntime("quit"));
    assert.isTrue(shouldDisposeExtensionRuntime("reload"));
  });

  it("interrupts owned delegation fibers during disposal", async () => {
    const runtime = createExtensionRuntime();
    const operation: Effect.Effect<DelegationState> = Effect.never;
    const fiber = await runtime.runPromise(
      Effect.flatMap(DelegationFibers, (delegations) =>
        delegations.run("dispose-test", operation),
      ),
    );

    await runtime.dispose();
    const exit = await Effect.runPromise(Fiber.await(fiber));

    assert.strictEqual(exit._tag, "Failure");
  });
});
