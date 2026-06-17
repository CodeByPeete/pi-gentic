import assert from "node:assert/strict";
import test from "node:test";
import { completeSend, isCompletingSendSession } from "../dist/commands.js";
import { persistSynchronousToolCard } from "../dist/runs.js";

test("send flag completion preserves message text before the completed flag", () => {
  const [completion] = completeSend("please review the patch --a");

  assert.equal(completion.value, "please review the patch --agent");

  assert.equal(completion.label, "--agent");
});

test("send agent completion preserves the message and agent flag", () => {
  const [completion] = completeSend("please review --agent res");

  assert.equal(completion.value, "please review --agent researcher");

  assert.equal(completion.label, "researcher");
});

test("send session completion starts immediately after the session flag", () => {
  const [completion] = completeSend("continue --session ", {
    sessions: [{ sessionId: "019eabcd-0000", lastMessage: "Review patch" }],
  });

  assert.equal(completion.value, "continue --session 019eabcd");

  assert.equal(completion.label, "019eabcd");
});

test("send session completion recognizes Pi argument prefixes", () => {
  assert.equal(isCompletingSendSession("continue --session "), true);

  assert.equal(isCompletingSendSession("continue --session=019e"), true);

  assert.equal(isCompletingSendSession("continue --agent "), false);
});

test("send flag completion includes override and worktree flags", () => {
  const labels = completeSend("continue --w").map((item) => item.label);

  assert.deepEqual(labels, ["--worktree"]);

  assert.ok(
    completeSend("continue --m").some((item) => item.label === "--model"),
  );
});

test("send model completion uses scoped model suggestions", () => {
  const [completion] = completeSend("continue --model gpt", {
    models: [
      { provider: "openai-codex", id: "gpt-5.4-mini" },
      { provider: "other", id: "claude" },
    ],
  });

  assert.equal(completion.value, "continue --model openai-codex/gpt-5.4-mini");
});

test("send worktree value completion suggests a message slug", () => {
  const [completion] = completeSend("Implement faster tree --worktree ");

  assert.equal(completion.value, "Implement faster tree --worktree implement-faster-tree");
});

test("send system prompt file completion uses configured suggestions", () => {
  const [completion] = completeSend("continue --system-prompt-files loc", {
    systemPromptFiles: ["local.md"],
  });

  assert.equal(completion.value, "continue --system-prompt-files local.md");
});

test("send filter override completion preserves comma prefixes", () => {
  const [completion] = completeSend("continue --tools read,+ba", {
    tools: ["read", "+bash"],
  });

  assert.equal(completion.value, "continue --tools read,+bash");
});

test("completed synchronous send tool cards are persisted for reopen", () => {
  const entries = [];
  const sessionManager = {
    appendCustomMessageEntry: (...args) => entries.push(args),
  };

  persistSynchronousToolCard(
    { sessionManager },
    { action: "send" },
    {
      text: "Agent answered.",
      details: { kind: "send", status: "done", sessionId: "child" },
    },
    () => entries.push(["flushed"]),
  );

  assert.deepEqual(entries[0], [
    "pi-gentic:card",
    "Agent answered.",
    true,
    { kind: "send", status: "done", sessionId: "child" },
  ]);

  assert.deepEqual(entries[1], ["flushed"]);
});

test("running send tool cards are not duplicated into persisted cards", () => {
  const entries = [];
  persistSynchronousToolCard(
    { sessionManager: { appendCustomMessageEntry: (...args) => entries.push(args) } },
    { action: "send" },
    { text: "Running", details: { kind: "send", status: "running" } },
  );

  assert.deepEqual(entries, []);
});

test("send session completion shows visible ids and session context", () => {
  const [completion] = completeSend("continue --session 019e", {
    sessions: [
      {
        sessionId: "019eabcd-0000",
        agentName: "reviewer",
        lastMessage: "Review patch",
      },
      { sessionId: "skip", lastMessage: "Current" },
    ],
    currentSessionId: "skip",
  });

  assert.equal(completion.value, "continue --session 019eabcd");

  assert.equal(completion.label, "019eabcd");

  assert.equal(completion.description, "[reviewer] Review patch");
});
