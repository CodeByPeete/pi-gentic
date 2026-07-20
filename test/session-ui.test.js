import assert from "node:assert/strict";
import test from "node:test";
import { TUI } from "@earendil-works/pi-tui";
import {
  AGENT_WIDGET_KEY,
  LIVE_REFRESH_WIDGET_KEY,
  clearLiveCardDetails,
  getLiveCardDetails,
  renderAgentsResult,
  setAgentLabel,
  setLiveCardDetails,
  showCard,
  startLiveRefresh,
  startSessionLiveCardRefresh,
} from "../dist/ui.js";

test("agent label appears right-aligned below the editor without a prefix", () => {
  const calls = [];

  setAgentLabel(
    { mode: "tui", ui: { setWidget: (...args) => calls.push(args) } },
    "builder",
  );

  assert.equal(calls.length, 1);

  assert.equal(calls[0][0], AGENT_WIDGET_KEY);

  assert.equal(typeof calls[0][1], "function");

  assert.deepEqual(calls[0][2], { placement: "belowEditor" });
  const line = calls[0][1]({}, {}).render(20)[0];

  assert.match(line, /builder/);

  assert.doesNotMatch(line, /agent:/);

  assert.match(line, /^\s+/);
});

test("clearing the agent removes the below-editor label", () => {
  const calls = [];

  setAgentLabel(
    { mode: "tui", ui: { setWidget: (...args) => calls.push(args) } },
    undefined,
  );

  assert.deepEqual(calls, [
    [AGENT_WIDGET_KEY, undefined, { placement: "belowEditor" }],
  ]);
});

test("live refresh mounts one stable widget above the editor", async () => {
  const calls = [];
  let renders = 0;
  const tui = { requestRender: () => renders++ };
  const stop = startLiveRefresh(
    {
      mode: "tui",
      ui: {
        setWidget: (...args) => {
          calls.push(args);
          args[1]?.(tui, {});
        },
      },
    },
    "test",
    { ttlMs: 10_000, intervalMs: 0, autoPulse: false },
  );

  stop.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  stop.refresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();

  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], `${LIVE_REFRESH_WIDGET_KEY}:test`);
  assert.deepEqual(calls[0][2], { placement: "aboveEditor" });
  assert.ok(renders > 0);
  assert.deepEqual(calls.at(-1), [
    `${LIVE_REFRESH_WIDGET_KEY}:test`,
    undefined,
    { placement: "aboveEditor" },
  ]);
});

test("live refresh follows the active TUI context after the tool context becomes stale", async () => {
  const staleCalls = [];
  const activeCalls = [];
  const staleContext = {
    mode: "tui",
    ui: {
      setWidget: (...args) => {
        staleCalls.push(args);
        throw new Error("This extension ctx is stale");
      },
    },
  };
  const activeContext = {
    mode: "tui",
    ui: { setWidget: (...args) => activeCalls.push(args) },
  };
  const stop = startLiveRefresh(staleContext, "context-switch", {
    ttlMs: 10_000,
    intervalMs: 0,
    autoPulse: false,
    resolveContext: () => activeContext,
  });

  stop.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  stop();

  assert.equal(staleCalls.length, 0);
  assert.equal(activeCalls[0][0], `${LIVE_REFRESH_WIDGET_KEY}:context-switch`);
  assert.equal(typeof activeCalls[0][1], "function");
});

test("live refresh repaints timers without remounting its widget", async () => {
  const calls = [];
  let renders = 0;
  const stop = startLiveRefresh(
    {
      mode: "tui",
      ui: {
        setWidget: (...args) => {
          calls.push(args);
          args[1]?.({ requestRender: () => renders++ }, {});
        },
      },
    },
    "timer",
    { ttlMs: 10_000, intervalMs: 0, pulseIntervalMs: 250 },
  );

  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `${LIVE_REFRESH_WIDGET_KEY}:timer`);
  assert.ok(renders > 0);

  stop();
  const rendered = renders;
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(renders, rendered);
  assert.deepEqual(calls.at(-1), [
    `${LIVE_REFRESH_WIDGET_KEY}:timer`,
    undefined,
    { placement: "aboveEditor" },
  ]);
});

test("live panel gives every active card one compact detailed row", async () => {
  const cards = [
    {
      cardId: "compact-one",
      kind: "send",
      status: "running",
      livePanel: true,
      callerSessionId: "parent-session",
      sessionId: "child-one",
      agentName: "researcher",
      async: true,
      message: "Research redraw behavior",
      startedAt: Date.now() - 4_000,
      updatedAt: Date.now() - 1_000,
      activities: [{ type: "tool", name: "read", summary: "src/ui.ts" }],
    },
    {
      cardId: "compact-two",
      kind: "send",
      status: "queued",
      livePanel: true,
      callerSessionId: "parent-session",
      sessionId: "child-two",
      agentName: "builder",
      async: false,
      message: "Implement the terminal fix",
      startedAt: Date.now() - 2_000,
      updatedAt: Date.now() - 2_000,
      activities: [],
    },
  ];
  let panel;
  const ctx = {
    mode: "tui",
    sessionManager: {
      getSessionId: () => "parent-session",
      getEntries: () => [],
    },
    ui: {
      setWidget(_key, factory) {
        panel = factory?.(
          { terminal: { rows: 30 }, requestRender() {} },
          { bold: (text) => text, fg: (_name, text) => text },
        );
      },
    },
  };

  for (const card of cards) setLiveCardDetails(card);
  const stop = startSessionLiveCardRefresh(ctx);

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lines = panel.render(120);
    const researcherRows = lines.filter((line) => line.includes("researcher"));
    const builderRows = lines.filter((line) => line.includes("builder"));

    assert.equal(researcherRows.length, 1);
    assert.match(researcherRows[0], /\[ASYNC\].*\(child-on\).*\[read\] src\/ui\.ts.*idle.*total/);
    assert.equal(builderRows.length, 1);
    assert.match(builderRows[0], /\[SYNC\].*\(child-tw\).*Queued: Implement the terminal fix.*idle.*total/);
  } finally {
    stop();
    for (const card of cards) clearLiveCardDetails(card);
  }
});

test("live card updates stay in the visible panel without clearing terminal scrollback", async () => {
  const writes = [];
  const terminal = {
    columns: 100,
    rows: 12,
    write: (value) => writes.push(value),
    start() {},
    stop() {},
    hideCursor() {},
    showCursor() {},
    setTitle() {},
  };
  const tui = new TUI(terminal);
  const theme = { bold: (text) => text, fg: (_name, text) => text };
  const cardId = "scroll-safe-live-card";
  const details = {
    cardId,
    kind: "send",
    status: "running",
    livePanel: true,
    callerSessionId: "parent-session",
    sessionId: "child-session",
    agentName: "researcher",
    async: true,
    message: "Investigate terminal redraw behavior",
    startedAt: Date.now() - 2_000,
    updatedAt: Date.now() - 1_000,
    activities: [],
  };
  const historyCard = renderCard(details);
  const filler = {
    invalidate() {},
    render() {
      return Array.from({ length: 30 }, (_, index) => `history ${index}`);
    },
  };
  const editor = {
    invalidate() {},
    render() {
      return ["editor", "footer"];
    },
  };
  let widget;
  const ctx = {
    mode: "tui",
    sessionManager: {
      getSessionId: () => "parent-session",
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "agents",
            details,
          },
        },
      ],
    },
    ui: {
      setWidget(_key, factory) {
        if (widget) tui.removeChild(widget);
        widget = factory?.(tui, theme);
        if (widget) tui.addChild(widget);
        tui.requestRender();
      },
    },
  };

  setLiveCardDetails(details);
  tui.addChild(historyCard);
  tui.addChild(filler);
  tui.addChild(editor);
  tui.start();
  const stop = startSessionLiveCardRefresh(ctx);

  try {
    await new Promise((resolve) => setTimeout(resolve, 140));
    const redrawsBeforeUpdate = tui.fullRedraws;
    writes.length = 0;

    setLiveCardDetails({
      ...details,
      updatedAt: Date.now(),
      activities: [{ type: "tool", name: "read", summary: "src/ui.ts" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 140));

    assert.equal(tui.fullRedraws, redrawsBeforeUpdate);
    assert.equal(writes.some((value) => value.includes("\x1b[3J")), false);
    assert.match(writes.join(""), /\[read\].*src\/ui\.ts/);

    writes.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    assert.equal(tui.fullRedraws, redrawsBeforeUpdate);
    assert.equal(writes.some((value) => value.includes("\x1b[3J")), false);
    assert.match(writes.join(""), /idle.*total/);
  } finally {
    stop();
    tui.stop();
    clearLiveCardDetails({ cardId });
  }
});

function renderCard(details) {
  return renderAgentsResult(
    { content: [{ type: "text", text: details.message }], details },
    { expanded: false, isPartial: true },
    { bold: (text) => text, fg: (_name, text) => text },
    { args: {} },
  );
}

test("running cards and their repaint loop remain live until explicitly settled", () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalClearInterval = globalThis.clearInterval;
  const timers = [];
  const cardId = "long-silent-run";

  globalThis.setTimeout = (callback, ms) => {
    const timer = { callback, ms, unref() {} };
    timers.push(timer);
    return timer;
  };
  globalThis.setInterval = (callback, ms) => ({ callback, ms, unref() {} });
  globalThis.clearTimeout = () => {};
  globalThis.clearInterval = () => {};

  try {
    setLiveCardDetails({ cardId, kind: "send", status: "running" });
    const ctx = {
      mode: "tui",
      ui: { setWidget() {} },
      sessionManager: {
        getEntries: () => [
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "agents",
              details: { cardId, kind: "send", status: "running" },
            },
          },
        ],
      },
    };
    const stop = startSessionLiveCardRefresh(ctx);

    assert.equal(getLiveCardDetails({ cardId })?.status, "running");
    assert.equal(
      timers.some(({ ms }) => ms === 10 * 60_000),
      false,
    );

    stop();
    setLiveCardDetails({ cardId, status: "done", completedAt: Date.now() });
    assert.equal(
      timers.some(({ ms }) => ms === 60_000),
      true,
    );
  } finally {
    clearLiveCardDetails({ cardId });
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("resumed sessions with visible live cards refresh from live updates", async () => {
  const calls = [];
  const cardId = "send:live-child:1";
  const ctx = {
    mode: "tui",
    ui: { setWidget: (...args) => calls.push(args) },
    sessionManager: {
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "agents",
            details: { cardId, kind: "send", status: "running" },
          },
        },
      ],
    },
  };

  setLiveCardDetails({ cardId, kind: "send", status: "running" });
  const stop = startSessionLiveCardRefresh(ctx);

  await new Promise((resolve) => setTimeout(resolve, 0));
  const rendered = calls.length;

  setLiveCardDetails({ cardId, updatedAt: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, 120));

  stop();
  clearLiveCardDetails({ cardId });

  assert.ok(rendered > 0);

  assert.ok(calls.length > rendered);
});

test("sessions without live cards do not repaint while idle", async () => {
  const calls = [];
  const ctx = {
    mode: "tui",
    ui: { setWidget: (...args) => calls.push(args) },
    sessionManager: {
      getEntries: () => [
        {
          customType: "pi-gentic:card",
          display: true,
          details: { cardId: "stale-card", kind: "send", status: "running" },
        },
      ],
    },
  };

  const stop = startSessionLiveCardRefresh(ctx);
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0][1], "function");
  stop();

  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], undefined);
});

test("agent load cards are sent immediately to the visible session", () => {
  const calls = [];

  showCard({ sendMessage: (...args) => calls.push(args) }, "Loaded builder", {
    kind: "load",
    status: "done",
    agentName: "builder",
  });

  assert.deepEqual(calls, [
    [
      {
        customType: "pi-gentic:card",
        content: "Loaded builder",
        display: true,
        details: { kind: "load", status: "done", agentName: "builder" },
      },
    ],
  ]);
});
