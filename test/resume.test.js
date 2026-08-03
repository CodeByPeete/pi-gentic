import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Duration, Effect, Schedule, Stream } from "effect";
import { deleteRuntimeSession, loadPiCodingAgentPeer, setRuntimeSession } from "../dist/pi-host.js";
import {
  decorateResumeSelector,
  installResumeBridge,
  loadSessionListIsolated,
  visibleSessionMembership,
} from "../dist/resume.js";
import { createExtensionRuntime } from "../dist/runtime/ExtensionRuntime.js";
import { listFastSessionSkeletonsEffect, listSessionSkeletonsEffect } from "../dist/sessions.js";

const themeCodes = {
  accent: 35,
  dim: 90,
  error: 31,
  success: 32,
  warning: 33,
};
const testTheme = {
  fg: (color, text) => `\x1b[${themeCodes[color] ?? 39}m${text}\x1b[39m`,
  bg: (_color, text) => `\x1b[48;5;236m${text}\x1b[49m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

function writeSession(agentName) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-resume-"));
  const file = path.join(dir, "session.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session",
        id: "019f1111-aaaa-7000-8000-000000000001",
        timestamp: "2026-07-13T20:00:00.000Z",
        cwd: dir,
      }),
      JSON.stringify({
        type: "message",
        id: "message-1",
        parentId: null,
        timestamp: "2026-07-13T20:00:00.000Z",
        message: { role: "user", content: "Native session title" },
      }),
      JSON.stringify({
        type: "custom",
        id: "agent-1",
        parentId: "message-1",
        timestamp: "2026-07-13T20:00:01.000Z",
        customType: "pi-gentic:state",
        data: { agentName },
      }),
      JSON.stringify({
        type: "message",
        id: "message-2",
        parentId: "message-1",
        timestamp: "2026-07-13T20:00:02.000Z",
        message: { role: "user", content: "Recent session activity" },
      }),
    ].join("\n"),
    "utf8",
  );

  return { dir, file };
}

function nativeSelector() {
  const calls = { setSessions: 0, filterSessions: 0, selected: [] };
  const list = {
    allSessions: [],
    filteredSessions: [],
    selectedIndex: 0,
    maxVisible: 10,
    searchInput: { render: () => [">"] },
    setSessions(sessions) {
      calls.setSessions++;
      this.allSessions = sessions;
      this.filterSessions("");
    },
    filterSessions(query) {
      calls.filterSessions++;
      this.filteredSessions = this.allSessions
        .filter((session) => String(session.allMessagesText).toLowerCase().includes(query.toLowerCase()))
        .map((session) => ({
          session,
          depth: session.depth ?? 0,
          isLast: session.isLast ?? true,
          ancestorContinues: session.ancestorContinues ?? [],
        }));
    },
    render() {
      return [
        ">",
        "",
        ...this.filteredSessions.map(({ session }) => `  ${session.name ?? session.firstMessage}  1 now`),
      ];
    },
    onSelect(sessionPath) {
      calls.selected.push(sessionPath);
    },
  };
  const component = {
    header: { loading: false, render: () => ["Resume Session", "search hints", "action hints"] },
    getSessionList: () => list,
  };

  return { component, list, calls };
}

test("resume decorator builds on native session loading, filtering, and rendering", () => {
  const { dir, file } = writeSession("builder");
  const { component, list, calls } = nativeSelector();
  const dispose = decorateResumeSelector(component, undefined, testTheme);

  try {
    list.setSessions([
      {
        id: "019f1111-aaaa-7000-8000-000000000001",
        path: file,
        cwd: dir,
        modified: new Date("2026-07-13T20:00:00.000Z"),
        messageCount: 1,
        firstMessage: "Native session title",
        allMessagesText: "Native session title",
        depth: 1,
        isLast: false,
        ancestorContinues: [true],
      },
    ]);
    list.filterSessions("builder");
    list.showPath = true;
    const output = list.render(200).join("\n");

    assert.equal(calls.setSessions, 1);
    assert.ok(calls.filterSessions >= 2);
    assert.match(output, /○/);
    assert.match(output, /\[builder\]/);
    assert.match(output, /Recent session activity/);
    assert.match(output, /Native session title/);
    assert.match(output, /019f1111/);
    assert.match(output, /1 (?:now|\d+[mhdw]|\d+mo|\d+y)/);
    assert.ok(stripAnsi(output).indexOf("Recent session activity") < stripAnsi(output).indexOf("(019f1111)"));

    list.setSessions([
      {
        id: "019f1111-aaaa-7000-8000-000000000001",
        path: "/sessions/loading.jsonl",
        modified: new Date(),
        metadataPending: true,
      },
    ]);
    assert.match(stripAnsi(list.render(120).join("\n")), /Loading session details…/);
    assert.match(stripAnsi(component.header.render(120).join("\n")), /Loading session details… 0\/1/);
  } finally {
    dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("metadata refresh preserves the active resume search", () => {
  const { component, list } = nativeSelector();
  let query = "builder";
  list.searchInput.getValue = () => query;
  const dispose = decorateResumeSelector(component, undefined, testTheme);
  const sessions = [
    {
      id: "builder-session",
      path: "/sessions/builder.jsonl",
      modified: new Date(2),
      firstMessage: "Builder task",
      allMessagesText: "Builder task",
    },
    {
      id: "reviewer-session",
      path: "/sessions/reviewer.jsonl",
      modified: new Date(1),
      firstMessage: "Reviewer task",
      allMessagesText: "Reviewer task",
    },
  ];

  try {
    list.setSessions(sessions, false);

    assert.equal(list.filteredSessions.length, 1);
    assert.equal(list.filteredSessions[0].session.id, "builder-session");
    query = "reviewer";
    list.filterSessions(query);
    list.setSessions(sessions, false);
    assert.equal(list.filteredSessions.length, 1);
    assert.equal(list.filteredSessions[0].session.id, "reviewer-session");
  } finally {
    dispose();
  }
});

test("named sessions keep native filtering without warning-colored rows", () => {
  const { dir, file } = writeSession(undefined);
  const { component, list } = nativeSelector();
  const dispose = decorateResumeSelector(component, undefined, testTheme);

  try {
    list.setSessions([
      {
        id: "019f1111-aaaa-7000-8000-000000000001",
        path: file,
        cwd: dir,
        name: "Named session",
        modified: new Date("2026-07-13T20:00:00.000Z"),
        messageCount: 2,
        firstMessage: "Native session title",
        allMessagesText: "Native session title Recent session activity",
      },
    ]);
    const output = list.render(120).join("\n");

    assert.match(stripAnsi(output), /Named session · Latest: Recent session activity/);
    assert.doesNotMatch(output, /\x1b\[33m/);
  } finally {
    dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume decorator searches agent metadata and updates live timers", async () => {
  const { dir, file } = writeSession("researcher");
  const { component, list, calls } = nativeSelector();
  const sessionId = "019f1111-aaaa-7000-8000-000000000001";
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionFile: () => file,
  };
  const liveSession = { sessionManager, isStreaming: true };
  setRuntimeSession(sessionId, {
    session: liveSession,
    agentName: "researcher",
    lastActivityAt: new Date().toISOString(),
  });
  let renders = 0;
  const runtime = createExtensionRuntime();
  const dispose = decorateResumeSelector(component, () => renders++, testTheme, runtime);

  try {
    list.setSessions([
      {
        id: sessionId,
        path: file,
        cwd: dir,
        modified: new Date(),
        messageCount: 1,
        firstMessage: "Native session title",
        allMessagesText: "Native session title",
      },
    ]);
    list.filterSessions("researcher");
    assert.equal(list.filteredSessions.length, 1);
    const output = list.render(120).join("\n");
    assert.match(output, /●/);
    assert.match(output, /\x1b\[95m0s\x1b\[39m/);
    assert.ok(stripAnsi(output).indexOf("Native session title") < stripAnsi(output).indexOf("(019f1111)"));
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    assert.ok(renders > 0);
    const updatedOutput = list.render(120).join("\n");
    assert.notEqual(updatedOutput, output);
    assert.match(updatedOutput, /\x1b\[95m[1-9]\d*s\x1b\[39m/);
    list.onSelect(file);
    assert.deepEqual(calls.selected, [`pi-gentic-live:${sessionId}`]);

    liveSession.isStreaming = false;
    list.render(120);
  } finally {
    dispose();
    await runtime.dispose();
    deleteRuntimeSession(sessionId);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fast session skeletons preserve native tree metadata", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-session-skeleton-"));
  const parentId = "019f1111-aaaa-7000-8000-000000000001";
  const childId = "019f1111-aaaa-7000-8000-000000000002";
  const parentPath = path.join(dir, `${parentId}.jsonl`);
  const childPath = path.join(dir, `${childId}.jsonl`);
  const runtime = createExtensionRuntime();

  writeFileSync(
    parentPath,
    JSON.stringify({ type: "session", id: parentId, timestamp: "2026-07-13T20:00:00.000Z", cwd: dir }),
  );
  writeFileSync(
    childPath,
    JSON.stringify({
      type: "session",
      id: childId,
      timestamp: "2026-07-13T20:00:01.000Z",
      cwd: dir,
      parentSession: parentPath,
    }),
  );
  for (let index = 0; index < 500; index++) {
    const id = `019f2222-bbbb-7000-8000-${String(index).padStart(12, "0")}`;
    writeFileSync(
      path.join(dir, `${id}.jsonl`),
      JSON.stringify({ type: "session", id, timestamp: "2026-07-13T20:00:02.000Z", cwd: dir }),
    );
  }

  try {
    const sessions = await runtime.runPromise(listSessionSkeletonsEffect(dir, dir));
    const child = sessions.find((session) => session.id === childId);

    assert.equal(sessions.length, 502);
    assert.equal(child?.parentSessionPath, parentPath);
  } finally {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("current resume hydration includes the complete shared session family from a child cwd", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-shared-sessions-"));
  const parentCwd = path.join(dir, "parent");
  const childCwd = path.join(dir, "child-worktree");
  const parentId = "019f3333-aaaa-7000-8000-000000000001";
  const childId = "019f3333-aaaa-7000-8000-000000000002";
  const parentPath = path.join(dir, `${parentId}.jsonl`);
  const childPath = path.join(dir, `${childId}.jsonl`);
  const runtime = createExtensionRuntime();
  mkdirSync(parentCwd);
  mkdirSync(childCwd);
  writeFileSync(parentPath, `${JSON.stringify({ type: "session", version: 3, id: parentId, cwd: parentCwd })}\n`);
  writeFileSync(
    childPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: childId,
      cwd: childCwd,
      parentSession: parentPath,
    })}\n`,
  );

  try {
    const sessions = await runtime.runPromise(loadSessionListIsolated("current", [childCwd, dir]));

    assert.deepEqual(new Set(sessions.map((session) => session.id)), new Set([parentId, childId]));
    assert.equal(sessions.find((session) => session.id === childId)?.parentSessionPath, parentPath);
  } finally {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Effect membership polling emits live session changes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-membership-watch-"));
  const runtime = createExtensionRuntime();
  const changes = runtime.runPromise(
    visibleSessionMembership({
      sessionManager: { getCwd: () => dir, getSessionDir: () => dir },
    }).pipe(Stream.take(2), Stream.runCollect),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const id = "019f1111-aaaa-7000-8000-000000000098";
    const file = path.join(dir, `2026-07-13T21-00-00-000Z_${id}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: dir })}\n`);
    const emissions = [...(await changes)];

    assert.equal(emissions[0].length, 0);
    assert.equal(emissions[1][0]?.path, file);
  } finally {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Effect membership streams contain missing and stale visible scopes", async () => {
  const runtime = createExtensionRuntime();

  try {
    const missing = await runtime.runPromise(
      visibleSessionMembership({
        sessionManager: { getCwd: () => process.cwd(), getSessionDir: () => undefined },
      }).pipe(Stream.runCollect),
    );
    const stale = await runtime.runPromise(
      visibleSessionMembership({
        sessionManager: {
          getCwd: () => {
            throw new Error("stale context");
          },
        },
      }).pipe(Stream.runCollect),
    );

    assert.deepEqual([...missing], [[]]);
    assert.deepEqual([...stale], [[]]);
  } finally {
    await runtime.dispose();
  }
});

test("an open resume selector reconciles added and removed sessions without reopening", async () => {
  const { component, list } = nativeSelector();
  const runtime = createExtensionRuntime();
  const first = {
    id: "019f1111-aaaa-7000-8000-000000000001",
    path: "/sessions/first.jsonl",
    cwd: "/project",
    created: new Date(1),
    modified: new Date(1),
    firstMessage: "First",
  };
  const second = {
    ...first,
    id: "019f1111-aaaa-7000-8000-000000000002",
    path: "/sessions/second.jsonl",
    created: new Date(2),
    modified: new Date(2),
    firstMessage: "Second",
  };
  let membership = [first];
  const dispose = decorateResumeSelector(
    component,
    () => {},
    testTheme,
    runtime,
    Stream.fromEffectSchedule(
      Effect.sync(() => membership),
      Schedule.spaced(Duration.millis(50)),
    ),
  );

  try {
    list.setSessions([first], false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    membership = [second, first];
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(
      list.allSessions.map((session) => session.path),
      [second.path, first.path],
    );
    membership = [];
    for (let attempts = 0; list.allSessions.length > 0 && attempts < 20; attempts++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(list.allSessions, []);
  } finally {
    dispose();
    await runtime.dispose();
  }
});

test("resume decorator opens 1000-session lists without synchronous enrichment", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-resume-1000-"));
  const payload = "x".repeat(1_000);
  const sessions = Array.from({ length: 1_000 }, (_, index) => {
    const id = `019f${String(index).padStart(4, "0")}-aaaa-7000-8000-${String(index).padStart(12, "0")}`;
    const file = path.join(dir, `${id}.jsonl`);
    const messages = Array.from({ length: 10 }, (__, messageIndex) =>
      JSON.stringify({
        type: "message",
        id: `message-${messageIndex}`,
        message: { role: "assistant", content: payload },
      }),
    );

    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "session",
          id,
          timestamp: "2026-07-13T20:00:00.000Z",
          cwd: dir,
        }),
        JSON.stringify({
          type: "message",
          id: "title",
          message: { role: "user", content: `Session ${index}` },
        }),
        ...messages,
      ].join("\n"),
      "utf8",
    );

    return {
      id,
      path: file,
      cwd: dir,
      modified: new Date(index),
      messageCount: messages.length + 1,
      firstMessage: `Session ${index}`,
      allMessagesText: `Session ${index}`,
    };
  });
  const { component, list } = nativeSelector();
  list.sortMode = "threaded";
  list.nameFilter = "all";
  list.searchInput.getValue = () => "";
  const dispose = decorateResumeSelector(component, undefined, testTheme);
  const runtime = createExtensionRuntime();

  try {
    const startedAt = performance.now();
    const skeletons = await runtime.runPromise(listFastSessionSkeletonsEffect(dir, dir));
    const loadedAt = performance.now();
    list.setSessions(sessions, false);
    const durationMs = performance.now() - startedAt;
    const decorationMs = performance.now() - loadedAt;

    assert.equal(skeletons.length, 1_000);
    assert.equal(list.allSessions.length, 1_000);
    assert.equal(list.filteredSessions.length, 1_000);
    assert.equal(list.filteredSessions[0].session.firstMessage, "Session 999");
    assert.ok(decorationMs < 750, `Expected decoration under 750ms, took ${decorationMs.toFixed(1)}ms.`);
    assert.ok(
      durationMs < 1_200,
      `Expected the 1000-session selector to open under 1200ms, took ${durationMs.toFixed(1)}ms.`,
    );
  } finally {
    dispose();
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume decorator rejects an inaccessible native theme", () => {
  const { component } = nativeSelector();

  assert.throws(() => decorateResumeSelector(component, undefined, undefined), /active theme is inaccessible/);
});

test("resume decorator disposal is idempotent and restores native methods", () => {
  const { component, list, calls } = nativeSelector();
  const nativeSetSessions = list.setSessions;
  let nativeDisposals = 0;
  component.dispose = () => nativeDisposals++;
  const dispose = decorateResumeSelector(component, () => {}, testTheme);

  assert.notEqual(list.setSessions, nativeSetSessions);
  dispose();
  dispose();

  assert.equal(typeof list.setSessions, "function");
  list.setSessions([], false);
  assert.equal(calls.setSessions, 1);
  assert.equal(nativeDisposals, 1);
});

test("resume decorator rejects incompatible selectors without mutating them", () => {
  const component = { getSessionList: () => ({ render() {} }) };

  assert.throws(() => decorateResumeSelector(component), /unsupported native session list/);
  assert.equal(typeof component.getSessionList().render, "function");
});

test("resume cache stays complete across child cwd changes and persists native metadata", async () => {
  const { dir, file } = writeSession("builder");
  const childCwd = path.join(dir, "child-worktree");
  const missDir = mkdtempSync(path.join(tmpdir(), "pi-gentic-resume-miss-"));
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-gentic-resume-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(childCwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const peer = await loadPiCodingAgentPeer();
  const SessionManager = peer.SessionManager;
  const nativeList = SessionManager.list;
  const nativeListAll = SessionManager.listAll;
  let loads = 0;
  let rejectNativeList = false;
  SessionManager.listAll = async function countedListAll(...args) {
    loads++;
    if (rejectNativeList) throw new Error("native list unavailable");
    return nativeListAll.apply(this, args);
  };
  const runtime = createExtensionRuntime();

  try {
    await installResumeBridge(runtime);
    const first = await SessionManager.list(dir, dir);
    const fromChild = await SessionManager.list(childCwd, dir, () => {});

    assert.equal(first.length, 1);
    assert.equal(fromChild.length, 1);
    assert.equal(loads, 1);
    const cacheDir = path.join(agentDir, "pi-gentic", "runtime", "resume-cache");
    assert.equal(existsSync(cacheDir), true);
    assert.equal(
      readdirSync(cacheDir).some((name) => name.endsWith(".json")),
      true,
    );

    appendFileSync(
      file,
      `\n${JSON.stringify({
        type: "message",
        id: "message-3",
        parentId: "message-2",
        timestamp: "2026-07-13T20:00:03.000Z",
        message: { role: "assistant", content: "Changed session" },
      })}\n`,
      "utf8",
    );
    const stale = await SessionManager.list(childCwd, dir);
    assert.equal(stale.length, 1);
    let hydrated = stale;
    for (let attempts = 0; hydrated[0]?.messageCount === first[0].messageCount && attempts < 50; attempts++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      hydrated = await SessionManager.list(dir, dir);
    }

    assert.equal(hydrated[0].messageCount, first[0].messageCount + 1);
    assert.equal(loads, 2);

    rmSync(file);
    assert.deepEqual(await SessionManager.list(childCwd, dir), []);

    rejectNativeList = true;
    await assert.rejects(SessionManager.list(missDir, missDir), /native list unavailable/);
  } finally {
    SessionManager.list = nativeList;
    SessionManager.listAll = nativeListAll;
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
    rmSync(missDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("resume bridge decorates the native selector without replacing its host", async () => {
  const peer = await loadPiCodingAgentPeer();
  const runtime = createExtensionRuntime();
  await installResumeBridge(runtime);
  const bridge = globalThis[Symbol.for("pi-gentic.resume-bridge")];
  const originalSelector = bridge.originalShowSessionSelector;
  const { component, list } = nativeSelector();
  let disposed = 0;
  component.dispose = () => disposed++;
  let hostCalls = 0;
  let hostDone = 0;
  let finish;
  bridge.originalShowSessionSelector = function () {
    hostCalls += 1;
    return this.showSelector((done) => {
      finish = done;
      return { component };
    });
  };
  const mode = {
    showSelector: (create) => create(() => hostDone++),
    ui: { requestRender: () => {} },
  };

  try {
    const result = peer.InteractiveMode.prototype.showSessionSelector.call(mode);
    assert.equal(result.component, component);
    list.setSessions([]);
    assert.deepEqual(list.render(80), [">", ""]);
    finish();
    component.dispose();
    assert.equal(disposed, 1);
    assert.equal(hostDone, 1);
    assert.equal(hostCalls, 1);
    assert.equal(typeof mode.showSelector, "function");
  } finally {
    bridge.originalShowSessionSelector = originalSelector;
    await runtime.dispose();
  }
});
