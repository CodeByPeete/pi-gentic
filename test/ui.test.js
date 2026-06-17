import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionTreePicker,
  renderAgentsCall,
  renderAgentsResult,
  renderSessionTree,
} from "../dist/ui.js";
import { clearLiveCardDetails, setLiveCardDetails } from "../dist/ui.js";

const theme = {
  bold: (text) => `\x1b[1m${text}\x1b[22m`,

  fg: (_name, text) => text,
};

function sessions(count) {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `session-${String(index + 1).padStart(2, "0")}`,
    agentName: "builder",
    lastMessage: `Session ${index + 1}`,
    depth: index % 3 === 0 ? 0 : 1,
    inactiveMs: index * 1_000,
    running: true,
  }));
}

function text(lines) {
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidth(text) {
  const clean = String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

  return [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      clean,
    ),
  ].reduce((width, { segment }) => {
    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment))
      return width + 2;
    return width + 1;
  }, 0);
}

function terminalTextWidth(text) {
  const clean = String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

  return [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      clean,
    ),
  ].reduce((width, { segment }) => {
    if (/\p{Regional_Indicator}/u.test(segment)) return width + 2;

    if (segment.includes("\ufe0f")) return width + 2;

    if (segment.includes("\ufe0e")) return width + 1;

    if (/\p{Emoji_Presentation}/u.test(segment)) return width + 2;

    return width + 1;
  }, 0);
}

test("agents tool call shell stays invisible so only the result card is shown", () => {
  const output = renderAgentsCall({ action: "send", message: "hello" }, theme, {
    executionStarted: true,
    expanded: false,
  }).render(120);

  assert.deepEqual(output, []);
});

test("session tree renders only twelve session rows by default", () => {
  const output = text(
    renderSessionTree({ sessions: sessions(22) }, theme).render(100),
  );

  assert.equal([...output.matchAll(/Inactive:/g)].length, 12);

  assert.match(output, /Showing 1-12 of 22/);
});

test("session tree picker scrolls the selected item into a twelve-row viewport", () => {
  const picker = createSessionTreePicker(
    sessions(22),
    theme,
    () => {},
    () => {},
  );

  picker.handleInput("\x1b[6~");

  const output = text(picker.render(100));

  assert.equal([...output.matchAll(/Inactive:/g)].length, 12);

  assert.match(output, /Session 7/);

  assert.match(output, /> .*Session 13/);

  assert.match(output, /\(13\/22\)/);

  assert.doesNotMatch(output, /Session 1 .*Inactive:/);
});

test("session tree picker refreshes running sessions and keeps the selection", async () => {
  let requested = 0;
  const picker = createSessionTreePicker(
    [
      { sessionId: "parent", lastMessage: "Parent", running: false },
      {
        sessionId: "child",
        lastMessage: "Child",
        running: true,
        inactiveMs: 1000,
      },
    ],
    theme,
    () => {},
    () => requested++,
    {
      refreshSessions: async () => [
        { sessionId: "parent", lastMessage: "Parent", running: false },
        {
          sessionId: "child",
          lastMessage: "Child done",
          running: false,
          inactiveMs: 0,
        },
      ],
    },
  );

  picker.handleInput("\x1b[B");

  await picker.refresh();
  const output = text(picker.render(100));

  picker.dispose();

  assert.equal(requested, 2);

  assert.match(output, /> .*Child done/);

  assert.doesNotMatch(output, /Child done.*Inactive:/);
});

test("session tree always keeps session ids visible and only running sessions show inactive timers", () => {
  const output = text(
    renderSessionTree(
      {
        sessions: [
          {
            sessionId: "running-session-id",
            lastMessage: "Running ".repeat(30),
            running: true,
            modified: new Date(Date.now() - 1_000).toISOString(),
            inactiveMs: 1_000,
          },
          {
            sessionId: "idle-session-id",
            lastMessage: "Idle ".repeat(30),
            running: false,
            inactiveMs: 2_000,
          },
        ],
      },
      theme,
    ).render(100),
  );

  assert.equal([...output.matchAll(/Inactive:/g)].length, 1);

  assert.match(output, /running-.*Inactive:/);

  assert.match(output, /idle-ses/);

  assert.doesNotMatch(output, /idle-ses.*Inactive:/);
});

test("expanded cards render all body lines without truncation", () => {
  const systemPrompt = [
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
          systemPrompt,
        },
      },
      { expanded: true, isPartial: false },
      theme,
      { args: {}, isError: false },
    ).render(120),
  );

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
          error:
            "Session child-session [researcher] stopped before returning a final answer.",
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { args: {}, isError: false },
    ).render(120),
  );

  assert.match(output, /Agent stopped before answering\./);

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

test("send cards render live child activity and stop inactive timers when done", () => {
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
    { expanded: false, isPartial: false },
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
      { expanded: false, isPartial: false },
      theme,
      { args: {}, isError: false },
    ).render(120),
  );

  for (const line of output.split("\n"))
    assert.doesNotMatch(line, /^File:|^Session summary:|^- /);

  assert.match(output, /Done\. File:/);
});

test("session tree picker truncates wide selected rows within terminal width", () => {
  const picker = createSessionTreePicker(
    [
      {
        sessionId: "019eb810-b1fe-7c14-b1f6-f78fbbfaed52",
        lastMessage:
          "## Outlook draft is ready ✅ The NETWAYS email has been prepared **inside Outlook Web** and **not sent**. ### Draft details | Feld | Wert | |---|---| | Empfänger | `jobs@netways.de` | | Betreff | `Bewerbung als Developer / Software Entwickler (w/m/d)` |",
        running: false,
      },
    ],
    theme,
    () => {},
  );
  const lines = picker.render(240);

  for (const line of lines)
    assert.ok(
      visibleWidth(line) <= 240,
      `overflow: ${visibleWidth(line)} > 240\n${line}`,
    );
});

test("session tree picker keeps emoji clusters and flags within terminal width", () => {
  const picker = createSessionTreePicker(
    [
      {
        sessionId: "emoji-cluster-session",
        lastMessage: "Family 👨‍👩‍👧‍👦 flag 🇩🇪 accents é keycap 1️⃣ repeated ".repeat(
          10,
        ),
        running: false,
      },
    ],
    theme,
    () => {},
  );
  const lines = picker.render(120);

  for (const line of lines)
    assert.ok(
      visibleWidth(line) <= 120,
      `overflow: ${visibleWidth(line)} > 120\n${line}`,
    );
});

test("session tree keeps the right-side short session id intact when the row fits exactly", () => {
  const picker = createSessionTreePicker(
    [
      {
        sessionId: "019eb810-b1fe-7c14-b1f6-f78fbbfaed52",
        lastMessage:
          "## Outlook draft is ready ✅ The NETWAYS email has been prepared **inside Outlook Web** and **not sent**. ### Draft details | Feld | Wert | |---|---| | Empfänger | `jobs@netways.de` | | Betreff | `Bewerbung als Developer / Software Entwickler (w/m/d)` |",
        running: false,
      },
    ],
    theme,
    () => {},
  );
  const output = text(picker.render(140));

  assert.match(output, /\(019eb810\)/);

  assert.doesNotMatch(output, /\(019eb810…/);

  assert.doesNotMatch(output, /────────────────.*…/);
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
      { expanded: false, isPartial: false },
      theme,
      { args: {}, isError: true },
    ).render(140),
  );

  assert.match(output, /Ctrl\+O to expand\s+0s/);

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
      { expanded: false, isPartial: false },
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
