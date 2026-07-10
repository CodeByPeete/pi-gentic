import assert from "node:assert/strict";
import test from "node:test";
import {
  abortAgentCall,
  abortAgentCallsForSession,
  handleInteractiveEscape,
  hasAgentCallsForSession,
  registerAgentCall,
} from "../dist/pi-host.js";

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

test("aborting a target session passes the session skip guard to active calls", async () => {
  let received;
  const call = registerAgentCall({
    callerSessionId: "parent",
    targetSessionId: "child",
    abort: async (options) => {
      received = options;
    },
  });

  try {
    const count = await abortAgentCallsForSession("child", {
      actor: "test",
      skipSessionAbort: "child",
    });

    assert.equal(count, 1);

    assert.equal(received.skipSessionAbort, "child");
  } finally {
    call.unregister();
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

test("escape aborts running delegated work before returning control to Pi", async () => {
  let cancellable = true;
  let aborts = 0;
  let nativeEscapes = 0;
  const call = registerAgentCall({
    callerSessionId: "root",
    targetSessionId: "child",
    isCancellable: () => cancellable,
    abort: () => {
      aborts += 1;
      cancellable = false;
    },
  });
  const escape = () =>
    handleInteractiveEscape({
      sessionId: "root",
      isStreaming: false,
      nativeEscape: () => {
        nativeEscapes += 1;
      },
    });

  try {
    escape();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aborts, 1);
    assert.equal(nativeEscapes, 0);

    escape();
    escape();
    assert.equal(aborts, 1);
    assert.equal(nativeEscapes, 2);
  } finally {
    call.unregister();
  }
});

test("stopped delegated calls preserve Pi double-escape handling", async () => {
  let aborts = 0;
  let nativeEscapes = 0;
  const call = registerAgentCall({
    callerSessionId: "root",
    targetSessionId: "child",
    isCancellable: () => false,
    abort: () => {
      aborts += 1;
    },
  });
  const escape = () =>
    handleInteractiveEscape({
      sessionId: "root",
      isStreaming: false,
      nativeEscape: () => {
        nativeEscapes += 1;
      },
    });

  try {
    escape();
    escape();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aborts, 0);
    assert.equal(nativeEscapes, 2);
  } finally {
    call.unregister();
  }
});
