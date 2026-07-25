import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { Effect } from "effect";
import {
  AbortDelegation,
  CompleteDelegation,
  DelegationQueued,
  FailDelegation,
  StartDelegation,
  StopDelegation,
  transitionDelegation,
} from "../src/domain/delegation.js";

const queued = DelegationQueued.make({
  delegationId: "delegation-1",
  callerSessionId: "caller-1",
  targetSessionId: "target-1",
  queuedAt: 100,
});

describe("Delegation transitions", () => {
  it.effect("moves from queued through running to completed", () =>
    Effect.sync(() => {
      const running = transitionDelegation(
        queued,
        StartDelegation.make({ startedAt: 200 }),
      );
      assert.isTrue(Result.isSuccess(running));
      if (Result.isFailure(running)) return;
      const completed = transitionDelegation(
        running.success,
        CompleteDelegation.make({ completedAt: 300, answer: "done" }),
      );

      assert.isTrue(Result.isSuccess(completed));
      if (Result.isSuccess(completed)) {
        assert.strictEqual(completed.success._tag, "DelegationCompleted");
        assert.strictEqual(completed.success.answer, "done");
      }
    }),
  );

  it.effect("classifies every terminal outcome explicitly", () =>
    Effect.sync(() => {
      const running = transitionDelegation(
        queued,
        StartDelegation.make({ startedAt: 200 }),
      );
      assert.isTrue(Result.isSuccess(running));
      if (Result.isFailure(running)) return;

      const terminalEvents = [
        FailDelegation.make({ completedAt: 300, reason: "failed" }),
        StopDelegation.make({ completedAt: 300, reason: "stopped" }),
        AbortDelegation.make({ completedAt: 300, reason: "aborted" }),
      ];
      const tags = terminalEvents.map((event) => {
        const result = transitionDelegation(running.success, event);
        assert.isTrue(Result.isSuccess(result));
        return Result.isSuccess(result) ? result.success._tag : "invalid";
      });

      assert.deepStrictEqual(tags, [
        "DelegationFailed",
        "DelegationStopped",
        "DelegationAborted",
      ]);
    }),
  );

  it.effect("aborts a queued delegation before it starts", () =>
    Effect.sync(() => {
      const aborted = transitionDelegation(
        queued,
        AbortDelegation.make({ completedAt: 150, reason: "cancelled" }),
      );

      assert.isTrue(Result.isSuccess(aborted));
      if (Result.isSuccess(aborted)) {
        assert.strictEqual(aborted.success._tag, "DelegationAborted");
        assert.strictEqual(aborted.success.reason, "cancelled");
      }
    }),
  );

  it.effect("rejects a terminal event while still queued", () =>
    Effect.sync(() => {
      const invalid = transitionDelegation(
        queued,
        CompleteDelegation.make({ completedAt: 150, answer: "too early" }),
      );

      assert.isTrue(Result.isFailure(invalid));
      if (Result.isFailure(invalid)) {
        assert.strictEqual(invalid.failure.from, "DelegationQueued");
        assert.strictEqual(invalid.failure.event, "CompleteDelegation");
      }
    }),
  );

  it.effect("rejects a transition out of a terminal state", () =>
    Effect.sync(() => {
      const running = transitionDelegation(
        queued,
        StartDelegation.make({ startedAt: 200 }),
      );
      assert.isTrue(Result.isSuccess(running));
      if (Result.isFailure(running)) return;
      const completed = transitionDelegation(
        running.success,
        CompleteDelegation.make({ completedAt: 300, answer: "done" }),
      );
      assert.isTrue(Result.isSuccess(completed));
      if (Result.isFailure(completed)) return;
      const invalid = transitionDelegation(
        completed.success,
        StartDelegation.make({ startedAt: 400 }),
      );

      assert.isTrue(Result.isFailure(invalid));
      if (Result.isFailure(invalid)) {
        assert.strictEqual(invalid.failure.from, "DelegationCompleted");
        assert.strictEqual(invalid.failure.event, "StartDelegation");
      }
    }),
  );
});
