import assert from "node:assert/strict";
import test from "node:test";
import { TUI } from "@earendil-works/pi-tui";
import {
  AGENT_WIDGET_KEY,
  LIVE_REFRESH_WIDGET_KEY,
  clearLiveCardDetails,
  getLiveCardDetails,
  renderAgentsResult,
  sessionHasVisibleLiveCard,
  setAgentLabel,
  setLiveCardDetails,
  showCard,
  startLiveRefresh,
  startSessionLiveCardRefresh,
} from "../dist/ui.js";
import { createExtensionRuntime } from "../dist/runtime/ExtensionRuntime.js";

const runtime = createExtensionRuntime();
test.after(() => runtime.dispose());

test("agent label appears right-aligned below the editor without a prefix", () => {
  const calls = [];

  setAgentLabel({ mode: "tui", ui: { setWidget: (...args) => calls.push(args) } }, "builder");

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

  setAgentLabel({ mode: "tui", ui: { setWidget: (...args) => calls.push(args) } }, undefined);

  assert.deepEqual(calls, [[AGENT_WIDGET_KEY, undefined, { placement: "belowEditor" }]]);
});

test("live refresh mounts one stable widget above the editor", async () => {
  const calls = [];
  let renders = 0;
  let mounted;
  const tui = { requestRender: () => renders++ };
  const stop = startLiveRefresh(
    {
      mode: "tui",
      ui: {
        setWidget: (...args) => {
          calls.push(args);
          if (args[1]) mounted = args[1](tui, {});
        },
      },
    },
    runtime,
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
  assert.deepEqual(mounted.render(80), []);
  assert.deepEqual(calls.at(-1), [`${LIVE_REFRESH_WIDGET_KEY}:test`, undefined, { placement: "aboveEditor" }]);
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
  const stop = startLiveRefresh(staleContext, runtime, "context-switch", {
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
    runtime,
    "timer",
    { ttlMs: 10_000, intervalMs: 0, pulseIntervalMs: 250 },
  );

  for (let attempts = 0; renders === 0 && attempts < 20; attempts++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `${LIVE_REFRESH_WIDGET_KEY}:timer`);
  assert.ok(renders > 0);

  stop();
  const rendered = renders;
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(renders, rendered);
  assert.deepEqual(calls.at(-1), [`${LIVE_REFRESH_WIDGET_KEY}:timer`, undefined, { placement: "aboveEditor" }]);
});

test("live timer cadence never catches up with subsecond repaint bursts", async () => {
  const ticks = [];
  const tui = { requestRender: () => ticks.push(performance.now()) };
  const stop = startLiveRefresh(
    {
      mode: "tui",
      ui: { setWidget: (_key, factory) => factory?.(tui, {}) },
    },
    runtime,
    "steady-cadence",
    { pulseIntervalMs: 250, trackLiveCards: false },
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const blockedUntil = performance.now() + 800;
    while (performance.now() < blockedUntil) {}
    const resumedAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 650));
    const resumedTicks = ticks.filter((tick) => tick >= resumedAt);

    assert.ok(resumedTicks.length >= 3);
    assert.ok(resumedTicks.slice(1).every((tick, index) => tick - resumedTicks[index] >= 200));
  } finally {
    stop();
  }
});

test("live card lookup contains stale session-manager failures", () => {
  clearLiveCardDetails();
  setLiveCardDetails({
    cardId: "stale-session-card",
    kind: "send",
    status: "running",
  });

  assert.equal(
    sessionHasVisibleLiveCard({
      sessionManager: {
        getSessionId: () => {
          throw new Error("stale id");
        },
      },
    }),
    false,
  );
  assert.equal(
    sessionHasVisibleLiveCard({
      sessionManager: {
        getSessionId: () => "session",
        getEntries: () => {
          throw new Error("stale entries");
        },
      },
    }),
    false,
  );
  clearLiveCardDetails();
});

test("live refresh contains stale mount and unmount failures", () => {
  const mountFailure = startLiveRefresh(
    {
      mode: "tui",
      ui: {
        setWidget: () => {
          throw new Error("stale mount");
        },
      },
    },
    runtime,
    "mount-failure",
    { autoPulse: false },
  );
  assert.doesNotThrow(() => mountFailure.refresh());

  let mounted = false;
  const unmountFailure = startLiveRefresh(
    {
      mode: "tui",
      ui: {
        setWidget: (_key, factory) => {
          if (!factory && mounted) throw new Error("stale unmount");
          mounted = true;
        },
      },
    },
    runtime,
    "unmount-failure",
    { autoPulse: false },
  );
  unmountFailure.refresh();
  assert.doesNotThrow(() => unmountFailure());
});

test("managed runtime disposal stops live timer repaint fibers", async () => {
  const ownedRuntime = createExtensionRuntime();
  let renders = 0;
  const stop = startLiveRefresh(
    {
      mode: "tui",
      ui: {
        setWidget: (_key, factory) => factory?.({ requestRender: () => renders++ }, {}),
      },
    },
    ownedRuntime,
    "owned-timer",
    { pulseIntervalMs: 250 },
  );

  stop.refresh();
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(renders > 0);
    await ownedRuntime.dispose();
    const settledRenders = renders;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(renders, settledRenders);
  } finally {
    await ownedRuntime.dispose();
  }
});

test("live panel gives every active session one compact detailed row", async () => {
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
    {
      cardId: "compact-three",
      kind: "send",
      status: "queued",
      livePanel: true,
      callerSessionId: "parent-session",
      sessionId: "child-two",
      agentName: "builder",
      async: false,
      message: "Continue the terminal fix",
      startedAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
      activities: [],
    },
    {
      cardId: "compact-agentless",
      kind: "send",
      status: "running",
      livePanel: true,
      callerSessionId: "parent-session",
      sessionId: "child-three",
      agentName: "agentless",
      async: true,
      message: "Handle an unassigned task",
      startedAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
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
  const stop = startSessionLiveCardRefresh(ctx, runtime);

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lines = panel.render(120);
    const researcherRows = lines.filter((line) => line.includes("researcher"));
    const builderRows = lines.filter((line) => line.includes("builder"));

    assert.equal(researcherRows.length, 1);
    assert.match(researcherRows[0], /\[ASYNC\].*\(child-on\).*\[read\] src\/ui\.ts.*idle.*total/);
    assert.equal(builderRows.length, 1);
    assert.match(builderRows[0], /\[SYNC\].*\(child-tw\).*Queued: Continue the terminal fix.*idle.*total/);
    assert.equal(lines.filter((line) => line.includes("agent (child-th)")).length, 1);
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
  const stop = startSessionLiveCardRefresh(ctx, runtime);

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
    assert.equal(
      writes.some((value) => value.includes("\x1b[3J")),
      false,
    );
    assert.match(writes.join(""), /\[read\].*src\/ui\.ts/);

    writes.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    assert.equal(tui.fullRedraws, redrawsBeforeUpdate);
    assert.equal(
      writes.some((value) => value.includes("\x1b[3J")),
      false,
    );
    assert.match(writes.join(""), /idle.*total/);
  } finally {
    stop();
    tui.stop();
    clearLiveCardDetails({ cardId });
  }
});

test("bounded activity cards retain the exact hidden activity count", () => {
  const card = renderCard({
    kind: "send",
    status: "running",
    live: true,
    message: "Long-running delegation",
    startedAt: Date.now() - 1_000,
    updatedAt: Date.now(),
    activityCount: 20_000,
    activities: Array.from({ length: 100 }, (_, index) => ({
      id: `tool-${index}`,
      type: "tool",
      name: "edit",
      summary: `file-${index}.ts`,
    })),
  });

  assert.match(card.render(100).join("\n"), /\[\+19991 activities\]/);
});

function renderCard(details) {
  return renderAgentsResult(
    { content: [{ type: "text", text: details.message }], details },
    { expanded: false, isPartial: true },
    { bold: (text) => text, fg: (_name, text) => text },
    { args: {} },
  );
}

test("running cards and their repaint loop remain live until explicitly settled", async () => {
  const cardId = "long-silent-run";

  try {
    setLiveCardDetails({ cardId, kind: "send", status: "running" }, { runtime });
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
    const stop = startSessionLiveCardRefresh(ctx, runtime);

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(getLiveCardDetails({ cardId })?.status, "running");

    stop();
    setLiveCardDetails({ cardId, status: "done", completedAt: Date.now() }, { runtime, ttlMs: 1_000 });
    setLiveCardDetails({ cardId, status: "done" }, { runtime, ttlMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(getLiveCardDetails({ cardId }), undefined);
  } finally {
    clearLiveCardDetails({ cardId });
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
  const stop = startSessionLiveCardRefresh(ctx, runtime);

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

  const stop = startSessionLiveCardRefresh(ctx, runtime);
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
