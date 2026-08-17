import assert from "node:assert/strict";
import test from "node:test";
import { renderAgentsCall, renderAgentsResult } from "../dist/interface/cards/render.js";
import {
  CARD_STATE_ENTRY_TYPE,
  restorePersistedCardDetails,
  setLiveCardDetails,
} from "../dist/interface/cards/state.js";
import { clearLiveCardDetails } from "./support/cards.js";

const theme = {
  bold: (text) => `\x1b[1m${text}\x1b[22m`,

  fg: (_name, text) => text,
};

function text(lines) {
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function terminalTextWidth(text) {
  const clean = String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(clean)].reduce((width, { segment }) => {
    if (/\p{Regional_Indicator}/u.test(segment)) return width + 2;

    if (segment.includes("\ufe0f")) return width + 2;

    if (segment.includes("\ufe0e")) return width + 1;

    if (/\p{Emoji_Presentation}/u.test(segment)) return width + 2;

    return width + 1;
  }, 0);
}

test("agents result renderer tolerates malformed native boundary values", () => {
  const emptyComponent = renderAgentsResult(null, null, theme, null);
  const malformedComponent = renderAgentsResult(
    {
      details: {
        status: 1,
        kind: false,
        cardId: {},
        sessionId: [],
        agentName: 2,
        message: null,
        answer: {},
        async: "yes",
        live: "yes",
        livePanel: "yes",
        startedAt: "now",
        updatedAt: Number.NaN,
        completedAt: "later",
        inactiveMs: "none",
        activities: {},
        configuration: [],
        sessions: {},
        systemPrompt: 1,
        error: false,
        restored: "yes",
      },
    },
    { expanded: "yes" },
    theme,
    { args: "invalid" },
  );

  assert.match(text(emptyComponent.render(80)), /✓ agents/i);
  assert.match(text(malformedComponent.render(80)), /✓ agents/i);
});

test("agents tool call renders its exact invocation at the transcript call site", () => {
  const call = renderAgentsCall(
    {
      action: "send",
      agent: "builder",
      message: "hello",
      fork: true,
      cwd: "/repository",
      worktree: true,
    },
    theme,
    {
      toolCallId: "tool-call-1",
      executionStarted: true,
      expanded: true,
    },
  );

  call.invalidate();
  const output = text(call.render(120));

  assert.match(output, /Agent call/);
  assert.match(output, /toolCallId: tool-call-1/);
  assert.match(output, /action: send/);
  assert.match(output, /agent: builder/);
  assert.match(output, /message: hello/);
  assert.match(output, /fork: true/);
  assert.match(output, /cwd: \/repository/);
  assert.match(output, /worktree: true/);
});

test("expanded delegation cards show resolved changes without repeating call properties", () => {
  const output = text(
    renderAgentsResult(
      {
        content: [{ type: "text", text: "Delegated from session parent." }],
        details: {
          kind: "delegation",
          status: "done",
          sessionId: "child-session",
          call: {
            toolCallId: "tool-call-delegation",
            callerEntryId: "caller-entry",
            parameters: {
              action: "send",
              agent: "researcher",
              message: "Research the request",
            },
            effectiveParameters: {
              action: "send",
              agent: "researcher",
              message: "Research the request",
              async: false,
              fork: false,
              cwd: "/repository",
            },
          },
        },
      },
      { expanded: true },
      theme,
      {},
    ).render(160),
  );

  assert.equal(output.match(/action: send/g)?.length, 1);
  assert.equal(output.match(/agent: researcher/g)?.length, 1);
  assert.equal(output.match(/message: Research the request/g)?.length, 1);
  assert.match(output, /Resolved properties/);
  assert.match(output, /async: false/);
  assert.match(output, /fork: false/);
  assert.match(output, /cwd: \/repository/);
});

test("completed agent cards preserve exact invocation properties", () => {
  const call = renderAgentsCall({ action: "send", message: "delegate", repo: "/repository", worktree: "task" }, theme, {
    toolCallId: "tool-call-2",
    expanded: true,
  });
  const result = renderAgentsResult(
    {
      content: [{ type: "text", text: "done" }],
      details: {
        kind: "send",
        status: "done",
        answer: "done",
        call: {
          toolCallId: "tool-call-2",
          callerEntryId: "entry-7",
          parameters: { action: "send", message: "delegate", repo: "/repository", worktree: "task" },
        },
      },
    },
    { expanded: true, isPartial: false },
    theme,
    { args: {}, isError: false, lastComponent: call },
  );
  const output = text(result.render(120));

  assert.match(output, /toolCallId: tool-call-2/);
  assert.match(output, /callerEntryId: entry-7/);
  assert.match(output, /repo: \/repository/);
  assert.match(output, /worktree: task/);
});

test("expanded cards render all body lines without truncation", () => {
  const systemPrompt = [
    "The following skills provide specialized instructions for specific tasks.",
    "<available_skills><skill><name>debug</name><description>Debug issues</description><location>/skills/debug/SKILL.md</location></skill></available_skills>",
    "This is a very long prompt line that must wrap cleanly without visual truncation markers because expanded cards should reveal the whole content.",
    ...Array.from({ length: 60 }, (_, index) => `prompt line ${index + 1}`),
  ].join("\n");
  const output = text(
    renderAgentsResult(
      {
        content: [{ type: "text", text: "Loaded researcher" }],
        details: {
          kind: "load",
          status: "done",
          agentName: "researcher",
          configuration: {
            tools: ["read", "grep"],
            model: { provider: "openai", id: "test" },
            thinking: "high",
          },
          systemPrompt,
        },
      },
      { expanded: true, isPartial: false },
      theme,
      { args: {}, isError: false },
    ).render(120),
  );

  assert.match(output, /Skill: debug/);
  assert.match(output, /Path: \/skills\/debug\/SKILL\.md/);
  assert.match(output, /prompt line 1/);

  assert.match(output, /prompt line 60/);

  assert.doesNotMatch(output, /…/);
});

test("restored agents cards do not show inactive timers when no live run exists", () => {
  const output = text(
    renderAgentsResult(
      {
        content: [{ type: "text", text: "Sent a message" }],
        details: {
          kind: "send",
          status: "running",
          sessionId: "child-session",
          message: "hello",
          startedAt: Date.now() - 120_000,
          updatedAt: Date.now() - 60_000,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { args: {}, isError: false },
    ).render(120),
  );

  assert.doesNotMatch(output, /Inactive:/);
});

test("persisted orchestration snapshots keep their captured inactivity", () => {
  const originalNow = Date.now;

  try {
    Date.now = () => 1_000_000;
    const component = renderAgentsResult(
      {
        content: [{ type: "text", text: "session snapshot" }],
        details: {
          kind: "discoverSessions",
          status: "done",
          sessions: [
            {
              sessionId: "running-session",
              agentName: "researcher",
              lastMessage: "Historical running session",
              running: true,
              inactiveMs: 19_000,
              lastActivityAt: 900_000,
            },
          ],
        },
      },
      { expanded: true, isPartial: false },
      theme,
      { args: {}, isError: false },
    );
    const before = text(component.render(120));

    Date.now = () => 2_000_000;
    const after = text(component.render(120));

    assert.equal(after, before);
    assert.match(after, /Inactive: 19s/);
  } finally {
    Date.now = originalNow;
  }
});

test("active transcript cards remain stable while live inactivity stays in the panel", () => {
  const originalNow = Date.now;
  const cardId = "active-send-card";

  try {
    Date.now = () => 1_000_000;
    setLiveCardDetails({
      cardId,
      kind: "send",
      status: "running",
      updatedAt: 940_000,
    });
    const component = renderAgentsResult(
      {
        content: [{ type: "text", text: "active send" }],
        details: { cardId, kind: "send", status: "running" },
      },
      { expanded: false, isPartial: true },
      theme,
      { args: {}, isError: false },
    );
    const before = text(component.render(120));

    Date.now = () => 1_001_000;
    const after = text(component.render(120));

    assert.equal(after, before);
    assert.doesNotMatch(after, /Inactive:/);
  } finally {
    clearLiveCardDetails({ cardId });
    Date.now = originalNow;
  }
});

test("restored running send cards render stable historical duration", () => {
  const originalNow = Date.now;

  try {
    Date.now = () => 1_000_000;
    const component = renderAgentsResult(
      {
        content: [{ type: "text", text: "Sent a message" }],
        details: {
          kind: "send",
          status: "running",
          sessionId: "child-session",
          message: "hello",
          startedAt: 100_000,
          updatedAt: 160_000,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { args: {}, isError: false },
    );
    const before = text(component.render(120));
    Date.now = () => 2_000_000;
    const after = text(component.render(120));

    assert.equal(after, before);
    assert.match(after, /Sent a message to/);
    assert.doesNotMatch(after, /Inactive:/);
  } finally {
    Date.now = originalNow;
  }
});

test("terminal card state restores duration and activities after restart", () => {
  const originalNow = Date.now;
  const cardId = "persisted-completion";
  const startedAt = 1_000_000;
  const completedAt = 1_450_000;
  const initialDetails = {
    cardId,
    kind: "send",
    status: "running",
    agentName: "researcher",
    sessionId: "child-session",
    message: "research dependencies",
    startedAt,
    updatedAt: startedAt,
    activities: [],
  };

  try {
    restorePersistedCardDetails({
      getBranch: () => [
        {
          type: "custom",
          customType: CARD_STATE_ENTRY_TYPE,
          data: {
            ...initialDetails,
            status: "done",
            answer: "Dependency research completed",
            completedAt,
            updatedAt: completedAt - 1_000,
            activities: [{ type: "tool", name: "write", summary: "research.json" }],
          },
        },
      ],
    });
    restorePersistedCardDetails({
      getBranch: () => [
        {
          type: "custom",
          customType: CARD_STATE_ENTRY_TYPE,
          data: {
            cardId: "another-session-card",
            kind: "send",
            status: "done",
          },
        },
      ],
    });
    Date.now = () => 2_000_000;
    const output = text(
      renderAgentsResult(
        {
          content: [{ type: "text", text: "Sent a message" }],
          details: initialDetails,
        },
        { expanded: true, isPartial: false },
        theme,
        { args: {}, isError: false },
      ).render(120),
    );

    assert.match(output, /Agent answered\./);
    assert.match(output, /Dependency research completed/);
    assert.doesNotMatch(output, /research dependencies/);
    assert.match(output, /\[write\] research\.json/);
    assert.match(output, /7m:30s/);
    assert.doesNotMatch(output, /Inactive:/);
  } finally {
    Date.now = originalNow;
  }
});

test("persisted card restoration rejects malformed host entries", () => {
  assert.doesNotThrow(() =>
    restorePersistedCardDetails({
      getEntries: () => [
        null,
        { customType: "other", data: {} },
        {
          customType: CARD_STATE_ENTRY_TYPE,
          data: { cardId: "invalid", nested: () => "not JSON" },
        },
      ],
    }),
  );
});

test("collapsed send cards mark the agent call in three rows while expanded cards preserve details", () => {
  const result = {
    content: [{ type: "text", text: "Wrapped answer" }],
    details: {
      kind: "send",
      status: "done",
      agentName: "researcher",
      sessionId: "child-session",
      message: "Original task",
      answer: "Final answer",
      activities: [{ type: "tool", name: "read", summary: "result.json" }],
      startedAt: 1_000,
      completedAt: 2_000,
    },
  };
  const collapsed = renderAgentsResult(result, { expanded: false, isPartial: false }, theme, {
    args: {},
    isError: false,
  }).render(120);

  assert.equal(collapsed.length, 3);
  assert.match(text(collapsed), /Agent answered\. researcher/);
  assert.doesNotMatch(text(collapsed), /Final answer|Original task|result\.json|Ctrl\+O/);

  const expanded = text(
    renderAgentsResult(result, { expanded: true, isPartial: false }, theme, {
      args: {},
      isError: false,
    }).render(120),
  );
  assert.match(expanded, /Final answer/);
  assert.match(expanded, /\[read\] result\.json/);
  assert.match(expanded, /Ctrl\+O to collapse/);
});

test("completed cards from older sessions fall back to their returned content", () => {
  const output = text(
    renderAgentsResult(
      {
        content: [{ type: "text", text: "Historical agent answer" }],
        details: {
          kind: "send",
          status: "done",
          message: "Historical request",
          completedAt: 2_000,
        },
      },
      { expanded: true, isPartial: false },
      theme,
      { args: {}, isError: false },
    ).render(120),
  );

  assert.match(output, /Historical agent answer/);
  assert.doesNotMatch(output, /Historical request/);
});

test("completed cards do not repeat their answer as assistant activity", () => {
  const output = text(
    renderAgentsResult(
      {
        content: [{ type: "text", text: "Wrapped answer" }],
        details: {
          kind: "send",
          status: "done",
          message: "Original request",
          answer: "Final answer",
          activities: [
            { type: "assistant", text: "Final answer" },
            { type: "tool", name: "write", summary: "result.json" },
          ],
          completedAt: 2_000,
        },
      },
      { expanded: true, isPartial: false },
      theme,
      { args: {}, isError: false },
    ).render(120),
  );

  assert.equal([...output.matchAll(/Final answer/g)].length, 1);
  assert.match(output, /\[write\] result\.json/);
});

test("stopped send cards use a specific title instead of a generic failure", () => {
  const output = text(
    renderAgentsResult(
      {
        content: [{ type: "text", text: "stopped" }],
        details: {
          kind: "send",
          status: "stopped",
          agentName: "researcher",
          sessionId: "child-session",
          error: [
            "Session child-session [researcher] stopped before returning a final answer.",
            "Reason: The model reached its output token limit before returning a final answer.",
            "Recent model error: Input exceeds the context window.",
          ].join("\n"),
        },
      },
      { expanded: true, isPartial: false },
      theme,
      { args: {}, isError: false },
    ).render(120),
  );

  assert.match(output, /Agent stopped before answering\./);
  assert.match(output, /output token limit/);
  assert.match(output, /Input exceeds the context window\./);
  assert.doesNotMatch(output, /Agent call failed\./);
});

test("queued send cards use a queue title", () => {
  const output = text(
    renderAgentsResult(
      {
        content: [{ type: "text", text: "queued" }],
        details: {
          kind: "send",
          status: "queued",
          agentName: "researcher",
          sessionId: "child-session",
          message: "continue",
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { args: {}, isError: false },
    ).render(120),
  );

  assert.match(output, /Message queued\. researcher/);
});

test("send completion card displays the agent name only once in the header", () => {
  const output = text(
    renderAgentsResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          kind: "send",
          status: "done",
          agentName: "sypheros",
          sessionId: "child-session",
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { args: {}, isError: false },
    ).render(120),
  );

  assert.match(output, /Agent answered\. sypheros/);

  assert.equal([...output.matchAll(/sypheros/g)].length, 1);
});

test("send cards render completed child activity when expanded", () => {
  const component = renderAgentsResult(
    {
      content: [{ type: "text", text: "create a temporary file" }],
      details: {
        cardId: "send-card",
        kind: "send",
        status: "running",
        sessionId: "child-session",
        message: "create a temporary file",
        updatedAt: Date.now() - 60_000,
      },
    },
    { expanded: true, isPartial: false },
    theme,
    { args: {}, isError: false },
  );

  text(component.render(120));

  setLiveCardDetails({
    cardId: "send-card",
    sessionId: "child-session",
    kind: "send",
    status: "done",
    updatedAt: Date.now(),
    completedAt: Date.now(),
    activities: [{ type: "tool", name: "write", summary: "temporary file" }],
  });
  const output = text(component.render(120));

  clearLiveCardDetails({ cardId: "send-card" });

  assert.match(output, /Agent answered/);

  assert.match(output, /\[write\] temporary file/);

  assert.doesNotMatch(output, /Inactive:/);
});

test("send card activity renders multiline answers without breaking the box", () => {
  const output = text(
    renderAgentsResult(
      {
        content: [{ type: "text", text: "create a temporary file" }],
        details: {
          kind: "send",
          status: "done",
          sessionId: "child-session",
          message: "create a temporary file",
          activities: [
            {
              type: "assistant",
              text: "Done.\n\nFile:\n- `.agentfiles/temp-work/temporary-note.txt`\n\nSession summary:\n- Created a temporary file.",
            },
          ],
          completedAt: Date.now(),
        },
      },
      { expanded: true, isPartial: false },
      theme,
      { args: {}, isError: false },
    ).render(120),
  );

  for (const line of output.split("\n")) assert.doesNotMatch(line, /^File:|^Session summary:|^- /);

  assert.match(output, /Done\. File:/);
});

test("error footer keeps its duration text without a trailing ellipsis", () => {
  const output = text(
    renderAgentsResult(
      {
        content: [{ type: "text", text: "x" }],
        details: {
          kind: "send",
          status: "error",
          error: 'Ambiguous session reference "019eb85e" matches 2 sessions.',
          startedAt: Date.now() - 200,
          completedAt: Date.now(),
        },
      },
      { expanded: true, isPartial: false },
      theme,
      { args: {}, isError: true },
    ).render(140),
  );

  assert.match(output, /Ctrl\+O to collapse\s+0s/);

  assert.doesNotMatch(output, /0…/);
});

test("multiline aborted cards keep every rendered line inside the border", () => {
  const output = text(
    renderAgentsResult(
      {
        content: [{ type: "text", text: "aborted" }],
        details: {
          kind: "send",
          status: "aborted",
          async: true,
          sessionId: "019ecd34-898f-72fa-a885-41b783c0680d",
          error: [
            "Session 019ecd34 was aborted while handling your request.",
            "Aborted by: user in that session.",
            "Request: Count from 1 to 1000, one number per line, and keep going until finished.",
          ].join("\n"),
          startedAt: Date.now() - 1_000,
          completedAt: Date.now(),
        },
      },
      { expanded: true, isPartial: false },
      theme,
      { args: {}, isError: false },
    ).render(120),
  );

  for (const line of output.split("\n")) {
    assert.match(line, /^[╭│╰].*[╮│╯]$/u, line);
    assert.equal(terminalTextWidth(line), 120, line);
  }

  assert.match(output, /Aborted by: user in that session\./);

  assert.match(output, /Request: Count from 1 to 1000/);
});

test("cards preserve terminal geometry through repeated narrow and wide resizes", () => {
  const component = renderAgentsResult(
    {
      content: [{ type: "text", text: "A completed answer with Unicode 🧪 and enough text to wrap repeatedly." }],
      details: {
        kind: "send",
        status: "done",
        async: true,
        agentName: "builder",
        sessionId: "019ecd34-898f-72fa-a885-41b783c0680d",
        answer: "A completed answer with Unicode 🧪 and enough text to wrap repeatedly.",
        activities: Array.from({ length: 25 }, (_, index) => ({
          type: "tool",
          name: "write",
          summary: `nested/path/result-${index}.json`,
          status: "done",
        })),
        startedAt: Date.now() - 3_600_000,
        completedAt: Date.now(),
      },
    },
    { expanded: true, isPartial: false },
    theme,
    { args: {}, isError: false },
  );

  for (const width of [24, 40, 80, 160, 32, 120])
    for (const line of component.render(width)) assert.equal(terminalTextWidth(line), width, `${width}: ${line}`);
});

test("completed cards reuse stable renders and refresh after width or persisted detail changes", () => {
  const cardId = "send:cache-regression";
  const component = renderAgentsResult(
    {
      content: [{ type: "text", text: "Initial answer" }],
      details: {
        cardId,
        kind: "send",
        status: "done",
        answer: "Initial answer",
        activities: Array.from({ length: 100 }, (_, index) => ({
          type: "tool",
          name: "read",
          summary: `result-${index}.json`,
        })),
      },
    },
    { expanded: false, isPartial: false },
    theme,
    { args: {}, isError: false },
  );

  const wide = component.render(120);
  assert.strictEqual(component.render(120), wide);

  const narrow = component.render(80);
  assert.notStrictEqual(narrow, wide);
  assert.strictEqual(component.render(80), narrow);

  restorePersistedCardDetails({
    getBranch: () => [
      {
        customType: CARD_STATE_ENTRY_TYPE,
        data: {
          cardId,
          kind: "send",
          status: "done",
          agentName: "updated-agent",
          answer: "Updated persisted answer",
        },
      },
    ],
  });

  const updated = component.render(80);
  assert.notStrictEqual(updated, narrow);
  assert.match(text(updated), /updated-agent/);
  assert.strictEqual(component.render(80), updated);
});
