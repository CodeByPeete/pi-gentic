import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildSessionTree,
  cachedPersistedSessions,
  enrichSessionSummaries,
  listSessionSummariesFast,
  orderSessionTree,
  resolveSessionReference,
  sessionCompletionScope,
  summarizeSession,
  treeSwitchPath,
} from "../dist/sessions.js";

const sessions = [
  { id: "12345678-aaaa", path: "/tmp/one.jsonl", firstMessage: "one" },
  { id: "87654321-bbbb", path: "/tmp/two.jsonl", firstMessage: "two" },
  { id: "abcdef12-cccc", path: "/tmp/three.jsonl", firstMessage: "three" },
];

test("resolves full session id", () => {
  assert.equal(
    resolveSessionReference(sessions, "12345678-aaaa").firstMessage,
    "one",
  );
});

test("resolves eight-character visible id", () => {
  assert.equal(
    resolveSessionReference(sessions, "87654321").firstMessage,
    "two",
  );
});

test("resolves unique longer prefix", () => {
  assert.equal(
    resolveSessionReference(sessions, "abcdef").firstMessage,
    "three",
  );
});

test("resolves unique substring", () => {
  assert.equal(
    resolveSessionReference(sessions, "54321-b").firstMessage,
    "two",
  );
});

test("rejects missing session reference", () => {
  assert.throws(
    () => resolveSessionReference(sessions, "missing"),
    /No session/,
  );
});

test("rejects ambiguous session reference", () => {
  assert.throws(() => resolveSessionReference(sessions, "1"), /Ambiguous/);
});

test("summary includes short id", () => {
  assert.deepEqual(summarizeSession(sessions[0]), {
    id: "12345678-aaaa",
    sessionId: "12345678-aaaa",
    shortId: "12345678",
    path: "/tmp/one.jsonl",
    parentSessionPath: undefined,
    name: undefined,
    firstMessage: "one",
    lastMessage: "one",
    modified: undefined,
    agentName: undefined,
  });
});

test("summary restores persisted active agent and last sent message", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-session-"));
  const filePath = path.join(dir, "session.jsonl");

  writeFileSync(
    filePath,
    [
      JSON.stringify({
        type: "session",
        id: "abcdef123456",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: dir,
      }),
      JSON.stringify({
        type: "custom",
        customType: "pi-gentic:state",
        data: { agentName: "researcher" },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Message from agent from session abcdef12:\nReview the latest patch\nOnly your final answer will be returned.",
            },
          ],
        },
      }),
    ].join("\n"),
  );

  const summary = summarizeSession(
    {
      id: "abcdef123456",
      path: filePath,
      firstMessage: "Child session",
      modified: "2026-01-01T00:00:00.000Z",
    },
    { enrich: true },
  );

  assert.equal(summary.agentName, "researcher");

  assert.equal(summary.lastMessage, "Review the latest patch");
});

test("session tree order keeps children directly under their parent", () => {
  const ordered = orderSessionTree([
    {
      path: "/child-b.jsonl",
      parentSessionPath: "/parent.jsonl",
      modified: "2026-01-01T00:00:04.000Z",
    },
    { path: "/other.jsonl", modified: "2026-01-01T00:00:03.000Z" },
    { path: "/parent.jsonl", modified: "2026-01-01T00:00:01.000Z" },
    {
      path: "/child-a.jsonl",
      parentSessionPath: "/parent.jsonl",
      modified: "2026-01-01T00:00:02.000Z",
    },
  ]);

  assert.deepEqual(
    ordered.map((session) => [session.path, session.depth, session.isLast]),
    [
      ["/parent.jsonl", 0, false],
      ["/child-b.jsonl", 1, false],
      ["/child-a.jsonl", 1, true],
      ["/other.jsonl", 0, true],
    ],
  );
});

test("session tree links children when only the parent session id is known", () => {
  const ordered = orderSessionTree([
    {
      sessionId: "019eafba",
      path: "/sessions/parent.jsonl",
      modified: "2026-01-01T00:00:01.000Z",
    },
    {
      sessionId: "019eafbf",
      path: "/sessions/child.jsonl",
      parentSessionId: "019eafba",
      modified: "2026-01-01T00:00:02.000Z",
    },
  ]);

  assert.deepEqual(
    ordered.map((session) => [session.sessionId, session.depth]),
    [
      ["019eafba", 0],
      ["019eafbf", 1],
    ],
  );
});

test("session tree links children when the parent path only carries the session id", () => {
  const ordered = orderSessionTree([
    {
      sessionId: "019eafba",
      path: "/sessions/2026-01-01_019eafba.jsonl",
      modified: "2026-01-01T00:00:01.000Z",
    },
    {
      sessionId: "019eafbf",
      path: "/sessions/2026-01-01_019eafbf.jsonl",
      parentSessionPath: "/old/019eafba.jsonl",
      modified: "2026-01-01T00:00:02.000Z",
    },
  ]);

  assert.deepEqual(
    ordered.map((session) => [session.sessionId, session.depth]),
    [
      ["019eafba", 0],
      ["019eafbf", 1],
    ],
  );
});

test("session completion scope keeps neighbors and starts with latest children", () => {
  const persisted = [
    {
      id: "root",
      path: "/root.jsonl",
      modified: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "current",
      path: "/current.jsonl",
      parentSessionPath: "/root.jsonl",
      modified: "2026-01-01T00:00:01.000Z",
    },
    {
      id: "child-old",
      path: "/child-old.jsonl",
      parentSessionPath: "/current.jsonl",
      modified: "2026-01-01T00:00:02.000Z",
    },
    {
      id: "child-new",
      path: "/child-new.jsonl",
      parentSessionPath: "/current.jsonl",
      modified: "2026-01-01T00:00:04.000Z",
    },
    {
      id: "sibling",
      path: "/sibling.jsonl",
      parentSessionPath: "/root.jsonl",
      modified: "2026-01-01T00:00:03.000Z",
    },
    {
      id: "distant",
      path: "/distant.jsonl",
      modified: "2026-01-01T00:00:05.000Z",
    },
  ];
  const current = persisted[1];
  const scoped = sessionCompletionScope(buildSessionTree(current, persisted), current, {
    rx: 1,
    ry: 1,
  });

  assert.deepEqual(
    scoped.map((session) => session.sessionId),
    ["child-new", "child-old", "sibling", "current", "root"],
  );
});

test("fast session list reads session headers and names", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-fast-list-"));
  const file = path.join(dir, "2026-01-01T00-00-00-000Z_fast-session.jsonl");

  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session",
        id: "fast-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: dir,
      }),
      JSON.stringify({ type: "session_info", name: "Fast session" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      }),
    ].join("\n"),
  );

  assert.deepEqual(
    listSessionSummariesFast(dir).map((session) => ({
      id: session.id,
      name: session.name,
      firstMessage: session.firstMessage,
    })),
    [{ id: "fast-session", name: "Fast session", firstMessage: "Hello" }],
  );
});

test("session summaries can defer persisted file enrichment", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-summary-"));
  const file = path.join(dir, "2026-01-01T00-00-00-000Z_session.jsonl");

  writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", id: "session", timestamp: new Date().toISOString(), cwd: dir }),
      JSON.stringify({ type: "custom", customType: "pi-gentic:state", data: { agentName: "reviewer" } }),
    ].join("\n"),
  );

  const fast = summarizeSession({ id: "session", path: file, modified: "1" });

  assert.equal(fast.agentName, undefined);

  const [enriched] = enrichSessionSummaries([fast]);

  assert.equal(enriched.agentName, "reviewer");
});

test("cached persisted session lists reuse in-flight loads", async () => {
  let calls = 0;
  const load = async () => {
    calls += 1;

    return [{ id: "one" }];
  };

  const [first, second] = await Promise.all([
    cachedPersistedSessions("unit-cache", load),
    cachedPersistedSessions("unit-cache", load),
  ]);

  assert.equal(calls, 1);

  assert.equal(first, second);
});

test("tree switch path attaches to live runtimes only while sessions are running", () => {
  assert.equal(
    treeSwitchPath({
      path: "/idle.jsonl",
      livePath: "pi-gentic-live:idle",
      running: false,
    }),
    "/idle.jsonl",
  );

  assert.equal(
    treeSwitchPath({
      path: "/running.jsonl",
      livePath: "pi-gentic-live:running",
      running: true,
    }),
    "pi-gentic-live:running",
  );

  assert.equal(
    treeSwitchPath({ livePath: "pi-gentic-live:running", running: true }),
    "pi-gentic-live:running",
  );

  assert.equal(
    treeSwitchPath({ path: "/running-without-live.jsonl", running: true }),
    "/running-without-live.jsonl",
  );
});
