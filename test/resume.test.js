import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteRuntimeSession,
  loadPiCodingAgentPeer,
  setRuntimeSession,
} from "../dist/pi-host.js";
import {
  decorateResumeSelector,
  installResumeBridge,
} from "../dist/resume.js";

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
        .filter((session) =>
          String(session.allMessagesText).toLowerCase().includes(query.toLowerCase()),
        )
        .map((session) => ({
          session,
          depth: 0,
          isLast: true,
          ancestorContinues: [],
        }));
    },
    render() {
      return [
        ">",
        "",
        ...this.filteredSessions.map(
          ({ session }) => `  ${session.name ?? session.firstMessage}  1 now`,
        ),
      ];
    },
    onSelect(sessionPath) {
      calls.selected.push(sessionPath);
    },
  };
  const component = { getSessionList: () => list };

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
      },
    ]);
    list.filterSessions("builder");
    const output = list.render(120).join("\n");

    assert.equal(calls.setSessions, 1);
    assert.ok(calls.filterSessions >= 2);
    assert.match(output, /○/);
    assert.match(output, /\[builder\]/);
    assert.match(output, /Recent session activity/);
    assert.match(output, /Native session title/);
    assert.match(output, /019f1111/);
    assert.match(output, /1 (?:now|\d+[mhdw]|\d+mo|\d+y)/);
    assert.ok(
      stripAnsi(output).indexOf("Recent session activity") <
        stripAnsi(output).indexOf("(019f1111)"),
    );
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

test("resume decorator searches agent metadata and selects a live runtime path", () => {
  const { dir, file } = writeSession("researcher");
  const { component, list, calls } = nativeSelector();
  const sessionId = "019f1111-aaaa-7000-8000-000000000001";
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionFile: () => file,
  };
  setRuntimeSession(sessionId, {
    session: { sessionManager, isStreaming: true },
    agentName: "researcher",
    lastActivityAt: new Date().toISOString(),
  });
  const dispose = decorateResumeSelector(component, undefined, testTheme);

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
    assert.ok(
      stripAnsi(output).indexOf("Native session title") <
        stripAnsi(output).indexOf("(019f1111)"),
    );

    list.onSelect(file);
    assert.deepEqual(calls.selected, [`pi-gentic-live:${sessionId}`]);
  } finally {
    dispose();
    deleteRuntimeSession(sessionId);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume decorator rejects an inaccessible native theme", () => {
  const { component } = nativeSelector();

  assert.throws(
    () => decorateResumeSelector(component, undefined, undefined),
    /active theme is inaccessible/,
  );
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

  assert.throws(
    () => decorateResumeSelector(component),
    /unsupported native session list/,
  );
  assert.equal(typeof component.getSessionList().render, "function");
});

test("resume session cache reuses unchanged native results and invalidates changed files", async () => {
  const { dir, file } = writeSession("builder");
  const peer = await loadPiCodingAgentPeer();
  const SessionManager = peer.SessionManager;
  const nativeList = SessionManager.list;
  let loads = 0;
  SessionManager.list = async function countedList(...args) {
    loads++;
    return nativeList.apply(this, args);
  };

  try {
    await installResumeBridge();
    const first = await SessionManager.list(dir, dir);
    const second = await SessionManager.list(dir, dir, () => {});

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
  } finally {
    SessionManager.list = nativeList;
    rmSync(dir, { recursive: true, force: true });
  }
});
