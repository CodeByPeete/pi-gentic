import assert from "node:assert/strict";
import test from "node:test";
import {
  abortAgentCall,
  abortAgentCallsForSession,
  hasAgentCallsForSession,
  registerAgentCall,
} from "../dist/runtime.js";

test("aborting a session aborts targeted agent calls recursively", async () => {
  const aborted = [];
  const first = registerAgentCall({
    callerSessionId: "root",
    targetSessionId: "child",
    abort: async () => aborted.push("child"),
  });
  const second = registerAgentCall({
    callerSessionId: "child",
    targetSessionId: "grandchild",
    abort: async () => aborted.push("grandchild"),
  });

  try {
    assert.equal(hasAgentCallsForSession("root"), true);
    const count = await abortAgentCallsForSession("root", { actor: "test" });

    assert.equal(count, 2);
    assert.deepEqual(aborted, ["grandchild", "child"]);
  } finally {
    first.unregister();
    second.unregister();
  }
});

test("aborting one tool call leaves sibling calls running", async () => {
  const aborted = [];
  const first = registerAgentCall({
    callerSessionId: "root",
    targetSessionId: "one",
    abort: async () => aborted.push("one"),
  });
  const second = registerAgentCall({
    callerSessionId: "root",
    targetSessionId: "two",
    abort: async () => aborted.push("two"),
  });

  try {
    await abortAgentCall(first.id, { actor: "test" });

    assert.deepEqual(aborted, ["one"]);
    assert.equal(hasAgentCallsForSession("root"), true);
  } finally {
    first.unregister();
    second.unregister();
  }
});
