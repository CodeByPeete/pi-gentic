import assert from "node:assert/strict";
import test from "node:test";
import {
  filterSessionNeighborhood,
  sessionDiscoveryScope,
} from "../dist/sessions.js";

test("session neighborhood keeps the current session when both radii are zero", () => {
  const sessions = [
    { sessionId: "root", depth: 0 },
    { sessionId: "left", parentSessionId: "root", depth: 1 },
    { sessionId: "current", parentSessionId: "root", depth: 1 },
    { sessionId: "right", parentSessionId: "root", depth: 1 },
  ];

  assert.deepEqual(
    filterSessionNeighborhood(sessions, sessions[2], { rx: 0, ry: 0 }).map(
      (session) => session.sessionId,
    ),
    ["current"],
  );
});

test("session neighborhood applies horizontal sibling radius", () => {
  const sessions = [
    { sessionId: "root", depth: 0 },
    { sessionId: "left", parentSessionId: "root", depth: 1 },
    { sessionId: "current", parentSessionId: "root", depth: 1 },
    { sessionId: "right", parentSessionId: "root", depth: 1 },
    { sessionId: "far", parentSessionId: "root", depth: 1 },
  ];

  assert.deepEqual(
    filterSessionNeighborhood(sessions, sessions[2], { rx: 1, ry: 0 }).map(
      (session) => session.sessionId,
    ),
    ["left", "current", "right"],
  );
});

test("session neighborhood applies vertical branch radius", () => {
  const sessions = [
    { sessionId: "root", depth: 0 },
    { sessionId: "current", parentSessionId: "root", depth: 1 },
    { sessionId: "child", parentSessionId: "current", depth: 2 },
    { sessionId: "grandchild", parentSessionId: "child", depth: 3 },
    { sessionId: "other-child", parentSessionId: "root", depth: 1 },
  ];

  assert.deepEqual(
    filterSessionNeighborhood(sessions, sessions[1], { rx: 0, ry: 1 }).map(
      (session) => session.sessionId,
    ),
    ["root", "current", "child"],
  );
});

test("session discovery scope can return the complete tree for the TUI", () => {
  const sessions = [
    { sessionId: "root", depth: 0 },
    { sessionId: "current", parentSessionId: "root", depth: 1 },
    { sessionId: "child", parentSessionId: "current", depth: 2 },
    { sessionId: "far-root", depth: 0 },
  ];

  assert.deepEqual(
    sessionDiscoveryScope(sessions, sessions[1], {
      all: true,
      rx: 0,
      ry: 0,
    }).map((session) => session.sessionId),
    ["root", "current", "child", "far-root"],
  );
});
