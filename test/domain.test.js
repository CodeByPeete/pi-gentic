import assert from "node:assert/strict";
import { test } from "node:test";
import {
  delegationReceipt as buildReceiptText,
  delegationReturn as buildReturnText,
} from "../dist/application/delegation/messages.js";
import { applyFilterList, mergeFilterLayers } from "../dist/domain/session-policy.js";
import { defaultAgentDir } from "../dist/infrastructure/configuration/agents.js";
import {
  booleanOr as chooseBoolean,
  errorMessage as getErrorMessage,
  formatDuration,
  isRecord,
  nonNegativeInteger as parseIntegerRadius,
  shortestUniqueSessionId,
  shortSessionId,
  stringList as toStringArray,
} from "../dist/shared/value.js";
import {
  normalizeToolInput,
  parseAgentCommand,
  parseSendCommand,
  tokenizeCommandLine,
} from "../dist/interface/commands.js";

const names = ["read", "write", "bash", "agents", "ask_question", "reviewer"];

test("tokenizer preserves quoted text as one token", () => {
  assert.deepEqual(tokenizeCommandLine('hello "wide world"'), ["hello", "wide world"]);
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
  assert.equal(parseSendCommand("hello --agent=researcher").agent, "researcher");
});

test("send supports --session value", () => {
  assert.equal(parseSendCommand("hello --session abc").sessionId, "abc");
});

test("send supports --cwd value", () => {
  assert.equal(parseSendCommand("hello --cwd /tmp/work").cwd, "/tmp/work");
});

test("send leaves unknown flags in message", () => {
  assert.equal(parseSendCommand("hello --unknown flag").message, "hello --unknown flag");
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
  assert.equal(parseSendCommand('say "hello there"').message, "say hello there");
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

  assert.equal(parseSendCommand('hello --repo "../source repo"').repo, "../source repo");
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
  assert.equal(normalizeToolInput({ action: " send ", message: "delegate" }).action, "send");
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

test("record and radius boundaries cover absence and malformed containers", () => {
  assert.equal(isRecord({ value: 1 }), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([]), false);
  assert.equal(parseIntegerRadius(undefined, "rx", 3), 3);
  assert.equal(parseIntegerRadius(null, "rx", 4), 4);
  assert.equal(parseIntegerRadius("2", "rx"), 2);
  assert.equal(formatDuration(-1_000), "0s");
  assert.deepEqual(applyFilterList(names, "read"), names);
});

test("the agent directory honors its environment override and native default", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = "custom-agent-dir";
    assert.equal(defaultAgentDir(), "custom-agent-dir");
    delete process.env.PI_CODING_AGENT_DIR;
    assert.match(defaultAgentDir(), /[\\/]\.pi[\\/]agent$/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("shared scalar helpers normalize every supported boundary shape", () => {
  assert.deepEqual(toStringArray(["read", 1, "write"]), ["read", "write"]);
  assert.deepEqual(toStringArray("read, write, "), ["read", "write"]);
  assert.equal(toStringArray(42), undefined);
  assert.equal(getErrorMessage(new Error("failed")), "failed");
  assert.equal(getErrorMessage("failed"), "failed");
  assert.equal(chooseBoolean(false, true), false);
  assert.equal(chooseBoolean("false", true), true);
});

test("filter layers preserve omission, ignore malformed layers, and honor denial", () => {
  assert.equal(mergeFilterLayers(undefined, "read"), undefined);
  assert.deepEqual(mergeFilterLayers(["read"], undefined, ["write"]), ["read", "write"]);
  assert.deepEqual(mergeFilterLayers(["read"], []), []);
});

test("shortest session ids expand across collisions and UUID separators", () => {
  assert.equal(shortestUniqueSessionId("12345678-abcd-final", ["12345678-abcd-other"]), "12345678-abcd-fina");
  assert.equal(shortestUniqueSessionId("short", []), "short");
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
  assert.deepEqual(applyFilterList(names, ["*", "!ba*"]), ["read", "write", "agents", "ask_question", "reviewer"]);
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

test("agentless receipt and return text use the generic agent label", () => {
  assert.match(buildReceiptText(undefined, "caller", "work"), /^Message from agent/);
  assert.match(buildReturnText(undefined, "child", "done"), /^Message from agent/);
});

test("receipt text requires completion before the child returns", () => {
  const receipt = buildReceiptText("researcher", "abcdefghi", "hello");

  assert.match(receipt, /session abcdefghi/);
  assert.match(receipt, /Complete the task before answering/);
  assert.match(receipt, /Only your final result/);
});

test("return text includes the exact agent session and answer", () => {
  const returned = buildReturnText("builder", "abcdefghi", "done");

  assert.match(returned, /session abcdefghi/);
  assert.match(returned, /done/);
});
