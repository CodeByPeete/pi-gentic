import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { WorktreeManager } from "../../../src/worktrees/manager.js";
import { createDelegationId, DelegationFibers } from "../../../src/delegation/runs.js";
import {
  createExtensionRuntime,
  prepareWorktreeEffect,
  shouldDisposeExtensionRuntime,
} from "../../../src/extension-runtime.js";

describe("ExtensionRuntime", () => {
  it("survives native session replacement and closes at host shutdown", () => {
    assert.isFalse(shouldDisposeExtensionRuntime("new"));
    assert.isFalse(shouldDisposeExtensionRuntime("resume"));
    assert.isFalse(shouldDisposeExtensionRuntime("fork"));
    assert.isTrue(shouldDisposeExtensionRuntime("quit"));
    assert.isTrue(shouldDisposeExtensionRuntime("reload"));
  });

  it("defers reload disposal until retained background work settles", async () => {
    const runtime = createExtensionRuntime();
    const release = runtime.retain();
    const disposal = runtime.disposeWhenIdle();

    assert.strictEqual(await runtime.runPromise(Effect.succeed("active")), "active");
    release();
    await disposal;
    await expect(runtime.runPromise(Effect.void)).rejects.toThrow("ManagedRuntime disposed");
  });

  it("cancels stale idle disposal and ignores duplicate lease releases", async () => {
    const runtime = createExtensionRuntime();
    const disposal = runtime.disposeWhenIdle();
    const release = runtime.retain();

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(await runtime.runPromise(Effect.succeed("retained")), "retained");
    release();
    release();
    await disposal;
  });

  it("disposes once and rejects leases after shutdown starts", async () => {
    const runtime = createExtensionRuntime();
    const firstDisposal = runtime.dispose();
    const secondDisposal = runtime.dispose();

    assert.strictEqual(firstDisposal, secondDisposal);
    assert.throws(() => runtime.retain(), /disposed extension runtime/i);
    await firstDisposal;
  });

  it.effect("prepares worktrees through the application service", () =>
    Effect.gen(function* () {
      const request = { message: "host request" };
      const result = yield* prepareWorktreeEffect(request).pipe(
        Effect.provideService(WorktreeManager, {
          prepare: (received) => Effect.succeed(String(received.message)),
        }),
      );

      assert.strictEqual(result, "host request");
    }),
  );

  it("interrupts owned delegation fibers during disposal", async () => {
    const runtime = createExtensionRuntime();
    const operation: Effect.Effect<void> = Effect.never;
    const fiber = await runtime.runPromise(
      Effect.flatMap(DelegationFibers, (delegations) => delegations.run(createDelegationId(), operation)),
    );

    await runtime.dispose();
    const exit = await Effect.runPromise(Fiber.await(fiber));

    assert.strictEqual(exit._tag, "Failure");
  });
});
