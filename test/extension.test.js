import assert from "node:assert/strict";
import test from "node:test";
import { completeSend, isCompletingSendSession } from "../dist/interface.js";
import { persistAgentCardState } from "../dist/orchestration.js";

test("send flag completion preserves message text before the completed flag", () => {
  const [completion] = completeSend("please review the patch --a");

  assert.equal(completion.value, "please review the patch --agent");

  assert.equal(completion.label, "--agent");
});

test("send agent completion preserves the message and agent flag", () => {
  const [completion] = completeSend("please review --agent res", {
    agents: [{ name: "researcher" }],
  });

  assert.equal(completion.value, "please review --agent researcher");

  assert.equal(completion.label, "researcher");
});

test("send session completion starts immediately after the session flag", () => {
  const [completion] = completeSend("continue --session ", {
    sessions: [{ sessionId: "019eabcd-0000", lastMessage: "Review patch" }],
  });

  assert.equal(completion.value, "continue --session 019eabcd-0000");

  assert.equal(completion.label, "019eabcd");
});

test("send session completion disambiguates sessions created in the same UUIDv7 time window", () => {
  const completions = completeSend("continue --session ", {
    sessions: [
      { sessionId: "019f4905-1bc8-7745-9be2-bfd327496429", agentName: "builder" },
      { sessionId: "019f4905-42d7-7c5e-ad3f-93d7fffc745f", agentName: "researcher" },
    ],
  });

  assert.deepEqual(
    completions.map(({ value, label }) => ({ value, label })),
    [
      {
        value: "continue --session 019f4905-1bc8-7745-9be2-bfd327496429",
        label: "019f4905-1bc8",
      },
      {
        value: "continue --session 019f4905-42d7-7c5e-ad3f-93d7fffc745f",
        label: "019f4905-42d7",
      },
    ],
  );
});

test("send session completion recognizes Pi argument prefixes", () => {
  assert.equal(isCompletingSendSession("continue --session "), true);

  assert.equal(isCompletingSendSession("continue --session=019e"), true);

  assert.equal(isCompletingSendSession("continue --agent "), false);
});

test("send flag completion includes override and worktree flags", () => {
  const labels = completeSend("continue --w").map((item) => item.label);

  assert.deepEqual(labels, ["--worktree"]);

  assert.ok(completeSend("continue --m").some((item) => item.label === "--model"));

  assert.deepEqual(
    completeSend("continue --r").map((item) => item.label),
    ["--repo"],
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

test("send repo value completion suggests the current repository", () => {
  const [completion] = completeSend("continue --repo ");

  assert.equal(completion.value, "continue --repo .");
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

test("send message completion includes available slash commands", () => {
  const completions = completeSend("/", {
    skills: ["tdd"],
    commands: [
      { name: "review", source: "prompt", description: "Review changes" },
      { name: "skill:frontend-design", source: "skill", description: "Design UI" },
      { name: "goal", source: "extension", description: "Complete goal" },
      { name: "send", source: "extension", description: "Pi-gentic send" },
    ],
  });

  assert.deepEqual(
    completions.map((completion) => completion.value),
    ["/review", "/skill:frontend-design", "/goal", "/send"],
  );
});

test("send skill command completion falls back to discovered skills", () => {
  const [completion] = completeSend("/skill:t", { skills: ["tdd"] });

  assert.equal(completion.value, "/skill:tdd");
});

test("send prompt command completion preserves the typed command token", () => {
  const [completion] = completeSend("please use /rev", {
    commands: [{ name: "review", source: "prompt" }],
  });

  assert.equal(completion.value, "please use /review");
});

test("terminal async card state is persisted outside model context", () => {
  const entries = [];
  const sessionManager = {
    appendCustomEntry: (...args) => entries.push(args),
  };
  const details = {
    cardId: "send:child:1",
    kind: "send",
    status: "done",
    answer: "Completed report",
    startedAt: 1_000,
    completedAt: 451_000,
    activities: [{ type: "tool", name: "write", summary: "report.json" }],
  };

  assert.equal(
    persistAgentCardState(sessionManager, details, () => entries.push(["flushed"])),
    true,
  );
  assert.deepEqual(entries, [["pi-gentic:card-state", details], ["flushed"]]);
});

test("running card state is not persisted as a completed snapshot", () => {
  const entries = [];

  assert.equal(
    persistAgentCardState(
      { appendCustomEntry: (...args) => entries.push(args) },
      { cardId: "send:child:1", status: "running" },
    ),
    false,
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

  assert.equal(completion.value, "continue --session 019eabcd-0000");

  assert.equal(completion.label, "019eabcd");

  assert.equal(completion.description, "[reviewer] Review patch");
});
