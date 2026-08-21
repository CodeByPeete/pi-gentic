import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { decodeAgentsToolInput, normalizeAgentsToolInput } from "../../../src/agents/tool.js";

describe("Agents tool contract", () => {
  it.effect("decodes action-specific fields into a discriminated request", () =>
    Effect.gen(function* () {
      const input = yield* decodeAgentsToolInput({
        action: "send",
        message: "delegate this",
        async: true,
        overrides: { tools: ["read"] },
      });

      assert.strictEqual(input.action, "send");
      if (input.action === "send") {
        assert.strictEqual(input.message, "delegate this");
        assert.isTrue(input.async);
      }
    }),
  );

  it.effect("rejects missing fields required by one action", () =>
    decodeAgentsToolInput({ action: "send" }).pipe(
      Effect.match({
        onFailure: (error) => Effect.sync(() => assert.match(error.message, /message/i)),
        onSuccess: () => Effect.die("send without a message unexpectedly decoded"),
      }),
    ),
  );

  it.effect("normalizes only the action token before schema decoding", () =>
    Effect.gen(function* () {
      const input = yield* normalizeAgentsToolInput({ action: " list " });

      assert.strictEqual(input.action, "list");
    }),
  );

  it.effect("decodes every action without losing optional native parameters", () =>
    Effect.gen(function* () {
      const inputs = [
        { action: "list" },
        { action: "get", agent: "researcher" },
        { action: "status", sessionId: "session-1" },
        { action: "load", agent: "builder", overrides: { tools: ["read"] } },
        {
          action: "send",
          message: "delegate",
          agent: "builder",
          sessionId: "session-2",
          async: false,
          fork: true,
          cwd: "/workspace",
          worktree: true,
          repo: "/repository",
          invokeMeLater: true,
          overrides: { model: "provider/model" },
        },
        { action: "abort", sessionId: "session-3" },
        { action: "discoverSessions", rx: 2, ry: 3 },
      ] as const;
      const actions = yield* Effect.all(inputs.map((input) => decodeAgentsToolInput(input)));

      assert.deepEqual(
        actions.map((action) => action.action),
        ["list", "get", "status", "load", "send", "abort", "discoverSessions"],
      );
      assert.deepInclude(actions[3], { overrides: { tools: ["read"] } });
      assert.deepInclude(actions[4], {
        async: false,
        fork: true,
        worktree: true,
        invokeMeLater: true,
      });
      assert.deepInclude(actions[5], { sessionId: "session-3" });
      assert.deepInclude(actions[6], { rx: 2, ry: 3 });
    }),
  );

  it.effect("omits absent optional action fields", () =>
    Effect.gen(function* () {
      const actions = yield* Effect.all([
        decodeAgentsToolInput({ action: "load", agent: "builder" }),
        decodeAgentsToolInput({ action: "send", message: "minimal" }),
        decodeAgentsToolInput({ action: "abort" }),
        decodeAgentsToolInput({ action: "discoverSessions" }),
      ]);

      assert.notProperty(actions[0], "overrides");
      assert.notProperty(actions[1], "agent");
      assert.notProperty(actions[2], "sessionId");
      assert.notProperty(actions[3], "rx");
      assert.notProperty(actions[3], "ry");
    }),
  );
});
