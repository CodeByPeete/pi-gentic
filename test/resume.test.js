import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteRuntimeSession,
  setRuntimeSession,
} from "../dist/pi-host.js";
import { decorateResumeSelector } from "../dist/resume.js";

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
  const dispose = decorateResumeSelector(component);

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
    assert.match(output, /1 now/);
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
  const dispose = decorateResumeSelector(component);

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
    assert.match(list.render(120).join("\n"), /●/);

    list.onSelect(file);
    assert.deepEqual(calls.selected, [`pi-gentic-live:${sessionId}`]);
  } finally {
    dispose();
    deleteRuntimeSession(sessionId);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume decorator rejects incompatible selectors without mutating them", () => {
  const component = { getSessionList: () => ({ render() {} }) };

  assert.throws(
    () => decorateResumeSelector(component),
    /unsupported native session list/,
  );
  assert.equal(typeof component.getSessionList().render, "function");
});
