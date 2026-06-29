import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_WIDGET_KEY,
  LIVE_REFRESH_WIDGET_KEY,
  clearLiveCardDetails,
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

test("live refresh is event-driven and uses an invisible below-editor widget", async () => {
  const calls = [];
  const stop = startLiveRefresh(
    { mode: "tui", ui: { setWidget: (...args) => calls.push(args) } },
    "test",
    { ttlMs: 10_000, intervalMs: 0 },
  );

  assert.equal(calls.length, 0);

  stop.refresh();

  await new Promise((resolve) => setTimeout(resolve, 0));

  stop();

  assert.equal(calls[0][0], `${LIVE_REFRESH_WIDGET_KEY}:test`);

  assert.equal(calls[0][1]({}, {}).render(80).length, 0);

  assert.deepEqual(calls[0][2], { placement: "belowEditor" });

  assert.deepEqual(calls.at(-1), [
    `${LIVE_REFRESH_WIDGET_KEY}:test`,
    undefined,
    { placement: "belowEditor" },
  ]);
});

test("live refresh stop clears the widget even before the first pulse", () => {
  const calls = [];
  const stop = startLiveRefresh(
    { mode: "tui", ui: { setWidget: (...args) => calls.push(args) } },
    "quick",
    { ttlMs: 10_000, intervalMs: 1000 },
  );

  stop.refresh();

  stop();

  assert.deepEqual(calls, [
    [
      `${LIVE_REFRESH_WIDGET_KEY}:quick`,
      undefined,
      { placement: "belowEditor" },
    ],
  ]);
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
          customType: "pi-gentic:card",
          display: true,
          details: { cardId, kind: "send", status: "running" },
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
