import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Duration, Effect, Schedule, Stream } from "effect";
import { deleteRuntimeSession, loadPiCodingAgentPeer, setRuntimeSession } from "../dist/pi-host.js";
import { decorateResumeSelector, installResumeBridge, visibleSessionMembership } from "../dist/resume.js";
import { createExtensionRuntime } from "../dist/runtime/ExtensionRuntime.js";
import { listSessionSkeletonsEffect } from "../dist/sessions.js";

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

  try {
    const sessions = await runtime.runPromise(listSessionSkeletonsEffect(dir, dir));
    const child = sessions.find((session) => session.id === childId);

    assert.equal(child?.parentSessionPath, parentPath);
  } finally {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Effect file watching emits live session membership changes", async () => {
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
    const skeletons = await runtime.runPromise(listSessionSkeletonsEffect(dir, dir));
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

test("resume session cache reuses unchanged native results and invalidates changed files", async () => {
  const { dir, file } = writeSession("builder");
  const missDir = mkdtempSync(path.join(tmpdir(), "pi-gentic-resume-miss-"));
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-gentic-resume-agent-"));
  const globalSessionDir = path.join(agentDir, "sessions", "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(globalSessionDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const peer = await loadPiCodingAgentPeer();
  const SessionManager = peer.SessionManager;
  const nativeList = SessionManager.list;
  const nativeListAll = SessionManager.listAll;
  let loads = 0;
  let delayNativeList = false;
  let rejectNativeList = false;
  SessionManager.list = async function countedList(...args) {
    loads++;
    if (rejectNativeList) throw new Error("native list unavailable");
    if (delayNativeList) await new Promise((resolve) => setTimeout(resolve, 150));
    return nativeList.apply(this, args);
  };
  SessionManager.listAll = async () => [
    {
      id: "all-session",
      path: file,
      created: new Date(),
      modified: new Date(),
    },
  ];

  const runtime = createExtensionRuntime();

  try {
    await installResumeBridge(runtime);
    const first = await SessionManager.list(dir, dir);
    const second = await SessionManager.list(dir, dir, () => {});
    const all = await SessionManager.listAll(dir);

    assert.equal(all.length, 1);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(loads, 1);

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
    const changed = await SessionManager.list(dir, dir);

    assert.equal(loads, 2);
    assert.equal(changed[0].messageCount, first[0].messageCount + 1);

    rmSync(file);
    const empty = await SessionManager.list(dir, dir);
    assert.equal(empty.length, 0);
    assert.equal(loads, 3);

    for (let index = 1; index <= 101; index++) {
      const sessionId = `019f${index.toString(16).padStart(4, "0")}-aaaa-7000-8000-${index.toString(16).padStart(12, "0")}`;
      const header = `${JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-07-13T21:00:00.000Z",
        cwd: dir,
      })}\n`;
      const fileName = `2026-07-13T21-00-00-000Z_${sessionId}.jsonl`;
      writeFileSync(path.join(dir, fileName), header);
      writeFileSync(path.join(globalSessionDir, fileName), header);
    }
    delayNativeList = true;
    const skeletons = await SessionManager.list(dir, dir);
    const allSkeletons = await SessionManager.listAll(dir);
    const globalSkeletons = await SessionManager.listAll();
    const concurrentStartedAt = performance.now();
    const concurrentSkeletons = await SessionManager.list(dir, dir);
    const concurrentMs = performance.now() - concurrentStartedAt;

    assert.equal(skeletons.length, 101);
    assert.equal(allSkeletons.length, 101);
    assert.equal(globalSkeletons.length, 101);
    assert.equal(concurrentSkeletons.length, 101);
    assert.match(String(skeletons[0].firstMessage), /^Session /);
    assert.ok(concurrentMs < 100, `Pending cache blocked resume for ${concurrentMs.toFixed(1)}ms.`);
    delayNativeList = false;
    let hydrated = skeletons;
    for (let attempts = 0; hydrated[0]?.firstMessage !== "(no messages)" && attempts < 50; attempts++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      hydrated = await SessionManager.list(dir, dir);
    }

    assert.equal(hydrated.length, 101);
    assert.equal(hydrated[0].firstMessage, "(no messages)");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(loads, 3);

    const newSessionId = "019f0066-aaaa-7000-8000-000000000066";
    writeFileSync(
      path.join(dir, `2026-07-13T21-01-00-000Z_${newSessionId}.jsonl`),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: newSessionId,
        timestamp: "2026-07-13T21:01:00.000Z",
        cwd: dir,
      })}\n`,
    );
    assert.equal((await SessionManager.list(dir, dir)).length, 102);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(loads, 3);

    rejectNativeList = true;
    assert.equal((await SessionManager.list(dir, dir)).length, 102);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loads, 3);
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
