import assert from "node:assert/strict";
import test from "node:test";
import {
  activeVisibleContext,
  deleteRuntimeSession,
  getLiveRuntimeState,
  getRuntimeSession,
  parkCurrentLiveRuntimeForSwitch,
  setRuntimeSession,
  shouldRunVisibleExtensionCommandNow,
  trackSessionPrompt,
} from "../dist/pi-host.js";

test("live runtime state is shared across duplicate module instances", async () => {
  const first = await import(`../dist/pi-host.js?instance=${Date.now()}-a`);
  const second = await import(`../dist/pi-host.js?instance=${Date.now()}-b`);

  assert.equal(first.getLiveRuntimeState(), second.getLiveRuntimeState());
});

test("runtime registry preserves object identity for live activity updates", () => {
  const runtime = {
    createdAt: "2026-01-01T00:00:00.000Z",
    session: {
      isStreaming: true,
      sessionManager: { getSessionId: () => "activity-session" },
    },
  };

  const stored = setRuntimeSession("activity-session", runtime);
  runtime.lastActivityAt = "2026-01-01T00:00:10.000Z";

  assert.equal(stored, runtime);

  assert.equal(
    getRuntimeSession("activity-session").lastActivityAt,
    "2026-01-01T00:00:10.000Z",
  );
});

test("active visible context is shared through live runtime state", () => {
  const state = getLiveRuntimeState();
  const previous = state.activeContext;
  const ctx = { sessionManager: { getSessionId: () => "visible-session" } };

  state.activeContext = ctx;

  assert.equal(activeVisibleContext(), ctx);

  state.activeContext = previous;
});

test("normal visible prompts are tracked while they are running", async () => {
  const session = {
    isStreaming: false,
    sessionManager: {
      getEntries: () => [],
      getHeader: () => ({ parentSession: "parent.jsonl" }),
      getSessionId: () => "visible-prompt-session",
    },
  };

  await trackSessionPrompt(
    session,
    async () => {
      session.isStreaming = true;
      const runtime = getRuntimeSession("visible-prompt-session");

      assert.equal(runtime.session, session);

      assert.equal(runtime.session.isStreaming, true);

      assert.equal(runtime.parentSessionPath, "parent.jsonl");

      assert.equal(runtime.lastMessage, "Normal prompt");

      session.isStreaming = false;
    },
    "Normal prompt",
  );

  assert.equal(
    getRuntimeSession("visible-prompt-session").session.isStreaming,
    false,
  );

  deleteRuntimeSession("visible-prompt-session");
});

test("visible extension commands run while a background session is streaming", () => {
  const runtime = {
    session: {
      isStreaming: true,
      sessionManager: { getSessionId: () => "background-session" },
    },
  };

  setRuntimeSession("background-session", runtime);

  try {
    assert.equal(
      shouldRunVisibleExtensionCommandNow(
        {
          session: {
            isStreaming: false,
            extensionRunner: { getCommand: (name) => name === "orchestration-tree" },
            sessionManager: { getSessionId: () => "visible-session" },
          },
        },
        "/orchestration-tree",
      ),
      true,
    );

    assert.equal(
      shouldRunVisibleExtensionCommandNow(
        {
          session: {
            isStreaming: false,
            extensionRunner: { getCommand: () => undefined },
            sessionManager: { getSessionId: () => "visible-session" },
          },
        },
        "/unknown",
      ),
      false,
    );
  } finally {
    deleteRuntimeSession("background-session");
  }
});

test("switching away from an opened live run parks it instead of disposing it", () => {
  const state = getLiveRuntimeState();
  state.liveRuntimes.clear();
  let disposed = 0;
  const session = {
    isStreaming: true,
    dispose: () => {
      disposed += 1;
    },
    sessionManager: { getSessionId: () => "running-session" },
  };
  const runtimeHost = { session };

  setRuntimeSession("running-session", { runtimeHost, session });
  const restore = parkCurrentLiveRuntimeForSwitch(state, runtimeHost);

  session.dispose();

  assert.equal(disposed, 0);

  assert.equal(state.liveRuntimes.get("running-session").runtime, runtimeHost);

  restore();
  session.dispose();

  assert.equal(disposed, 1);
});

test("switching away from an unregistered visible run parks it instead of disposing it", () => {
  const state = getLiveRuntimeState();
  state.liveRuntimes.clear();
  let disposed = 0;
  const session = {
    isStreaming: true,
    dispose: () => {
      disposed += 1;
    },
    sessionManager: { getSessionId: () => "visible-running-session" },
  };
  const runtimeHost = { session };
  const restore = parkCurrentLiveRuntimeForSwitch(state, runtimeHost);

  session.dispose();

  assert.equal(disposed, 0);

  assert.equal(
    state.liveRuntimes.get("visible-running-session").runtime.session,
    session,
  );

  runtimeHost.session = {
    sessionManager: { getSessionId: () => "next-session" },
  };

  assert.equal(
    state.liveRuntimes.get("visible-running-session").runtime.session,
    session,
  );

  restore();
  session.dispose();

  assert.equal(disposed, 1);
});
