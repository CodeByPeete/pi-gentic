import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFilterList,
  buildReceiptText,
  buildReturnText,
  formatDuration,
  parseIntegerRadius,
  shortSessionId,
} from "../dist/catalog.js";
import {
  normalizeToolInput,
  parseAgentCommand,
  parseSendCommand,
  tokenizeCommandLine,
} from "../dist/interface.js";

const names = ["read", "write", "bash", "agents", "ask_question", "reviewer"];

test("tokenizer preserves quoted text as one token", () => {
  assert.deepEqual(tokenizeCommandLine('hello "wide world"'), [
    "hello",
    "wide world",
  ]);
});

test("tokenizer unescapes newline inside quoted text", () => {
  assert.deepEqual(tokenizeCommandLine('"a\\nb"'), ["a\nb"]);
});

test("tokenizer keeps unknown escape outside quotes", () => {
  assert.deepEqual(tokenizeCommandLine("a\\-b"), ["a-b"]);
});

test("agent command reads agent name", () => {
  assert.deepEqual(parseAgentCommand("researcher"), {
    agent: "researcher",
    sessionId: undefined,
  });
});

test("agent command reads --session value", () => {
  assert.deepEqual(parseAgentCommand("researcher --session abc"), {
    agent: "researcher",
    sessionId: "abc",
  });
});

test("agent command reads --session=value", () => {
  assert.deepEqual(parseAgentCommand("researcher --session=abc"), {
    agent: "researcher",
    sessionId: "abc",
  });
});

test("send keeps a plain message", () => {
  assert.equal(parseSendCommand("hello there").message, "hello there");
});

test("send removes known --agent flag from message", () => {
  assert.deepEqual(parseSendCommand("hello --agent researcher"), {
    message: "hello",
    agent: "researcher",
    sessionId: undefined,
    fork: false,
    async: undefined,
    cwd: undefined,
    invokeMeLater: undefined,
    overrides: undefined,
    worktree: undefined,
    repo: undefined,
  });
});

test("send supports --agent=value", () => {
  assert.equal(
    parseSendCommand("hello --agent=researcher").agent,
    "researcher",
  );
});

test("send supports --session value", () => {
  assert.equal(parseSendCommand("hello --session abc").sessionId, "abc");
});

test("send supports --cwd value", () => {
  assert.equal(parseSendCommand("hello --cwd /tmp/work").cwd, "/tmp/work");
});

test("send leaves unknown flags in message", () => {
  assert.equal(
    parseSendCommand("hello --unknown flag").message,
    "hello --unknown flag",
  );
});

test("send last bg or fg wins", () => {
  assert.equal(parseSendCommand("hello --bg --fg").async, false);

  assert.equal(parseSendCommand("hello --fg --bg").async, true);
});

test("send last non-empty agent wins", () => {
  assert.equal(parseSendCommand("hello --agent a --agent b").agent, "b");
});

test("send fork flag becomes true", () => {
  assert.equal(parseSendCommand("hello --fork").fork, true);
});

test("send no-invoke maps to false", () => {
  assert.equal(parseSendCommand("hello --no-invoke").invokeMeLater, false);
});

test("send preserves quoted whitespace in message", () => {
  assert.equal(
    parseSendCommand('say "hello there"').message,
    "say hello there",
  );
});

test("send parses runtime override flags", () => {
  assert.deepEqual(
    parseSendCommand(
      "hello --model openai-codex/gpt-5.4-mini --thinking high --tools read,+bash --max-subagent-depth 3",
    ).overrides,
    {
      model: "openai-codex/gpt-5.4-mini",
      thinking: "high",
      tools: ["read", "+bash"],
      maxSubagentDepth: 3,
    },
  );
});

test("send supports --repo values for worktree source selection", () => {
  assert.equal(parseSendCommand("hello --repo ../source").repo, "../source");

  assert.equal(parseSendCommand("hello --repo=../source").repo, "../source");

  assert.equal(
    parseSendCommand('hello --repo "../source repo"').repo,
    "../source repo",
  );
});

test("send ignores repo without a value", () => {
  const parsed = parseSendCommand("hello --repo --worktree task");

  assert.equal(parsed.repo, undefined);

  assert.equal(parsed.worktree, "task");
});

test("send worktree flag can omit the branch value", () => {
  assert.deepEqual(
    {
      worktree: parseSendCommand("hello --worktree --cwd ../trees/task").worktree,
      cwd: parseSendCommand("hello --worktree --cwd ../trees/task").cwd,
    },
    { worktree: "", cwd: "../trees/task" },
  );
});

test("tool input requires object", () => {
  assert.throws(() => normalizeToolInput(null), /object/);
});

test("tool input requires action", () => {
  assert.throws(() => normalizeToolInput({}), /action/);
});

test("tool input trims action", () => {
  assert.equal(normalizeToolInput({ action: " send " }).action, "send");
});

test("radius floors decimals", () => {
  assert.equal(parseIntegerRadius(2.9, "rx"), 2);
});

test("radius rejects negatives", () => {
  assert.throws(() => parseIntegerRadius(-1, "rx"), /non-negative/);
});

test("radius rejects non-numbers", () => {
  assert.throws(() => parseIntegerRadius("nope", "rx"), /non-negative/);
});

test("filter star includes all", () => {
  assert.deepEqual(applyFilterList(names, ["*"]), names);
});

test("filter empty list allows nothing", () => {
  assert.deepEqual(applyFilterList(names, []), []);
});

test("filter substring includes matches", () => {
  assert.deepEqual(applyFilterList(names, ["write"]), ["write"]);
});

test("filter wildcard includes matches", () => {
  assert.deepEqual(applyFilterList(names, ["*er"]), ["reviewer"]);
});

test("filter exclusion removes matches", () => {
  assert.deepEqual(applyFilterList(names, ["*", "!ba*"]), [
    "read",
    "write",
    "agents",
    "ask_question",
    "reviewer",
  ]);
});

test("filter force include restores exact name", () => {
  assert.deepEqual(applyFilterList(names, ["read", "+bash"]), ["read", "bash"]);
});

test("filter force exclude beats force include", () => {
  assert.deepEqual(applyFilterList(names, ["*", "+bash", "-bash"]), [
    "read",
    "write",
    "agents",
    "ask_question",
    "reviewer",
  ]);
});

test("duration formats seconds", () => {
  assert.equal(formatDuration(12_300), "12s");
});

test("duration formats minutes", () => {
  assert.equal(formatDuration(65_000), "1m:05s");
});

test("duration formats hours", () => {
  assert.equal(formatDuration(3_661_000), "1h:01m:01s");
});

test("short session id takes first eight characters", () => {
  assert.equal(shortSessionId("123456789"), "12345678");
});

test("receipt text includes caller and final-answer instruction", () => {
  assert.match(
    buildReceiptText("researcher", "abcdefghi", "hello"),
    /Only your final answer/,
  );
});

test("return text includes agent and answer", () => {
  assert.match(buildReturnText("builder", "abcdefghi", "done"), /done/);
});
