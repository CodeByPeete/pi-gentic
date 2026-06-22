import assert from "node:assert/strict";
import test from "node:test";
import {
  activeVisibleContext,
  getLiveRuntimeState,
  getRuntimeSession,
  parkCurrentLiveRuntimeForSwitch,
  setRuntimeSession,
} from "../dist/runtime.js";

test("live runtime state is shared across duplicate module instances", async () => {
  const first = await import(`../dist/runtime.js?instance=${Date.now()}-a`);
  const second = await import(`../dist/runtime.js?instance=${Date.now()}-b`);

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
