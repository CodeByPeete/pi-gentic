import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Stream } from "effect";
import {
  RuntimeMetadata,
  RuntimeRegistry,
  RuntimeRegistryLive,
} from "../src/infrastructure/runtime/RuntimeRegistry.js";

describe("RuntimeRegistry", () => {
  it.layer(RuntimeRegistryLive)((it) => {
    it.effect("registers, updates, observes, and removes one runtime identity", () =>
      Effect.gen(function* () {
        const registry = yield* RuntimeRegistry;
        const runtime = { kind: "test-runtime" };
        const metadata = RuntimeMetadata.make({
          sessionId: "session-1",
          parentSessionId: "caller-1",
          agentName: "builder",
          createdAt: 100,
          lastActivityAt: 100,
        });
        const ready = yield* Deferred.make<void>();
        const observed = yield* registry.changes.pipe(
          Stream.tap(() => Deferred.succeed(ready, undefined)),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        yield* registry.register(metadata, runtime);
        yield* registry.touch("session-1", 200);
        const current = yield* registry.get("session-1");
        assert.isTrue(Option.isSome(current));
        if (Option.isSome(current)) {
          assert.strictEqual(current.value.runtime, runtime);
          assert.strictEqual(current.value.metadata.lastActivityAt, 200);
        }
        yield* registry.remove("session-1");
        yield* registry.touch("missing-session", 300);
        yield* registry.remove("missing-session");
        const missing = yield* registry.get("missing-session");
        const listed = yield* registry.list;
        const snapshots = yield* Fiber.join(observed);

        assert.isTrue(Option.isNone(missing));
        assert.strictEqual(listed.length, 0);
        assert.strictEqual(snapshots.length, 4);
        assert.strictEqual(snapshots[0].length, 0);
        assert.strictEqual(snapshots[1][0]?.metadata.sessionId, "session-1");
        assert.strictEqual(snapshots[2][0]?.metadata.lastActivityAt, 200);
        assert.strictEqual(snapshots[3].length, 0);
      }),
    );
  });
});
