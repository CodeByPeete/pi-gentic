import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import {
  activeDelegationMap,
  awaitJoinedDelegations,
  createDelegationId,
  getActiveDelegation,
  listActiveDelegations,
  registerActiveDelegation,
  settleActiveDelegation,
} from "../src/infrastructure/runtime/DelegationRegistry.js";

describe("DelegationRegistry", () => {
  it.effect("exposes one stable identity and idempotent settlement", () =>
    Effect.gen(function* () {
      const id = createDelegationId();
      const registration = registerActiveDelegation({
        id,
        callerSessionId: "registry-caller",
        targetSessionId: "registry-target",
        completionMode: "detached",
        isCancellable: () => true,
      });

      assert.match(id, /^delegation:[0-9a-f-]{36}$/);
      assert.strictEqual(getActiveDelegation(id)?.id, id);
      assert.isTrue(activeDelegationMap().has(id));
      assert.isTrue(getActiveDelegation(id)?.isCancellable?.());
      assert.isFalse(settleActiveDelegation("delegation:00000000-0000-0000-0000-000000000000"));
      assert.isTrue(settleActiveDelegation(id));
      assert.isFalse(registration.unregister());
      assert.isUndefined(getActiveDelegation(id));
      assert.isUndefined(getActiveDelegation(""));
      assert.strictEqual(yield* awaitJoinedDelegations(id), 0);
    }),
  );

  it("rejects a duplicate active identity without replacing the first registration", () => {
    const first = registerActiveDelegation({
      id: "duplicate-registry-id",
      callerSessionId: "duplicate-caller",
      completionMode: "detached",
    });

    try {
      assert.throws(
        () =>
          registerActiveDelegation({
            id: "duplicate-registry-id",
            callerSessionId: "replacement-caller",
            completionMode: "detached",
          }),
        /already registered/i,
      );
      assert.strictEqual(getActiveDelegation(first.id)?.callerSessionId, "duplicate-caller");
    } finally {
      first.unregister();
    }
  });

  it.effect("joins every requested delegation while detached work remains independent", () =>
    Effect.gen(function* () {
      const parent = registerActiveDelegation({
        id: "joined-parent",
        callerSessionId: "joined-root",
        targetSessionId: "joined-caller",
        completionMode: "detached",
      });
      const first = registerActiveDelegation({
        id: "joined-child-1",
        callerSessionId: "joined-caller",
        targetSessionId: "joined-target-1",
        completionMode: "joined",
      });
      const second = registerActiveDelegation({
        id: "joined-child-2",
        callerSessionId: "joined-caller",
        targetSessionId: "joined-target-2",
        completionMode: "joined",
      });
      const detached = registerActiveDelegation({
        id: "detached-child",
        callerSessionId: "joined-caller",
        targetSessionId: "detached-target",
        completionMode: "detached",
      });
      const waiting = yield* Effect.forkChild(awaitJoinedDelegations(parent.id));

      yield* Effect.yieldNow;
      assert.isUndefined(waiting.pollUnsafe());

      first.unregister();
      yield* Effect.yieldNow;
      assert.isUndefined(waiting.pollUnsafe());

      second.unregister();
      assert.strictEqual(yield* Fiber.join(waiting), 2);
      assert.isTrue(listActiveDelegations().some(({ id }) => id === detached.id));

      detached.unregister();
      parent.unregister();
    }),
  );

  it.effect("joins work to every active delegation sharing its caller run", () =>
    Effect.gen(function* () {
      const firstParent = registerActiveDelegation({
        id: "shared-parent-1",
        callerSessionId: "shared-root-1",
        targetSessionId: "shared-caller",
        completionMode: "detached",
      });
      const secondParent = registerActiveDelegation({
        id: "shared-parent-2",
        callerSessionId: "shared-root-2",
        targetSessionId: "shared-caller",
        completionMode: "detached",
      });
      const child = registerActiveDelegation({
        id: "shared-child",
        callerSessionId: "shared-caller",
        targetSessionId: "shared-target",
        completionMode: "joined",
      });
      const firstWaiting = yield* Effect.forkChild(awaitJoinedDelegations(firstParent.id));
      const secondWaiting = yield* Effect.forkChild(awaitJoinedDelegations(secondParent.id));

      yield* Effect.yieldNow;
      assert.isUndefined(firstWaiting.pollUnsafe());
      assert.isUndefined(secondWaiting.pollUnsafe());

      child.unregister();
      assert.strictEqual(yield* Fiber.join(firstWaiting), 1);
      assert.strictEqual(yield* Fiber.join(secondWaiting), 1);
      firstParent.unregister();
      secondParent.unregister();
    }),
  );

  it.effect("interrupting a joined wait leaves the delegation active", () =>
    Effect.gen(function* () {
      const parent = registerActiveDelegation({
        id: "interrupted-parent",
        callerSessionId: "interrupted-root",
        targetSessionId: "interrupted-caller",
        completionMode: "detached",
      });
      const child = registerActiveDelegation({
        id: "interrupted-child",
        callerSessionId: "interrupted-caller",
        targetSessionId: "interrupted-target",
        completionMode: "joined",
      });
      const waiting = yield* Effect.forkChild(awaitJoinedDelegations(parent.id));

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(waiting);
      assert.isTrue(listActiveDelegations().some(({ id }) => id === child.id));

      child.unregister();
      parent.unregister();
    }),
  );
});
