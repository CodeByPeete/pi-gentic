import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyFilterList } from "../dist/core.js";
import {
  availableAgentLines,
  filterSkillPrompt,
  parseSkillEntries,
} from "../dist/prompt.js";
import { abortActor } from "../dist/runs.js";
import { deliverReturnToCaller, displayTargetAnswerIfVisible } from "../dist/runs.js";
import {
  sendConfirmationText,
  sendPendingText,
  shouldDeferSendCompletion,
} from "../dist/runs.js";
import { sessionRunOutcome } from "../dist/runs.js";
import { formatSessionStatus, sessionStatus } from "../dist/runs.js";
import { assertAvailableAgent, filterAvailableAgents } from "../dist/policy.js";
import { resolveSessionPolicy } from "../dist/policy.js";
import { prepareWorktree } from "../dist/worktrees.js";

function createGitRepo(prefix = path.join(tmpdir(), "pi-gentic-worktree-repo-")) {
  const repo = mkdtempSync(prefix);

  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: repo,
    stdio: "ignore",
  });

  return repo;
}

test("resolved agent prompt only exposes configured skills and includes available agent descriptions", () => {
  const basePrompt = [
    "Base prompt",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
    "  <skill>",
    "    <name>tdd</name>",
    "    <description>Test-first development</description>",
    "    <location>C:/skills/tdd/SKILL.md</location>",
    "  </skill>",
    "  <skill>",
    "    <name>frontend-design</name>",
    "    <description>Frontend design</description>",
    "    <location>C:/skills/frontend-design/SKILL.md</location>",
    "  </skill>",
    "</available_skills>",
  ].join("\n");
  const allowedSkills = applyFilterList(
    parseSkillEntries(basePrompt).map((skill) => skill.name),
    ["tdd"],
  );
  const prompt = `${filterSkillPrompt(basePrompt, parseSkillEntries(basePrompt), allowedSkills)}\n${availableAgentLines(
    [
      { name: "researcher", description: "Finds reliable context" },
      { name: "builder", description: "Builds patches" },
    ],
    ["researcher"],
  )}`;

  assert.match(
    prompt,
    /Available skills\n- tdd: Test-first development\n  Path: C:\/skills\/tdd\/SKILL\.md/,
  );

  assert.doesNotMatch(prompt, /frontend-design/);

  assert.doesNotMatch(prompt, /<[^>]+>/);

  assert.match(prompt, /researcher: Finds reliable context/);
});

test("send with no invoke returns answer as context without triggering a caller turn", async () => {
  const sentMessages = [];
  const pi = {
    sendMessage: (message, options) => sentMessages.push({ message, options }),
    sendUserMessage: () => {
      throw new Error("should not invoke caller");
    },
  };

  await deliverReturnToCaller({
    pi,
    ctx: {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "caller" },
      isIdle: () => true,
    },
    callerSessionManager: { appendMessage() {}, appendCustomMessageEntry() {} },
    text: "Message from [worker] agent from session target:\nWorker answer",
    invoke: false,
  });

  assert.equal(sentMessages[0].options.triggerTurn, false);

  assert.equal(sentMessages[0].message.customType, "pi-gentic:return-context");

  assert.match(sentMessages[0].message.content, /Worker answer/);
});

test("send return uses the active visible session after a session switch", async () => {
  const sent = [];

  const mode = await deliverReturnToCaller({
    pi: {
      sendMessage: () => {
        throw new Error("stale pi should not be used");
      },
    },
    ctx: {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "caller" },
      isIdle: () => true,
    },
    callerSessionId: "caller",
    callerSessionManager: { appendCustomMessageEntry() {} },
    text: "Visible answer",
    invoke: false,
    visibleSession: {
      sendCustomMessage: (...args) => sent.push(args),
    },
  });

  assert.equal(mode, "live");

  assert.equal(sent[0][0].content, "Visible answer");

  assert.deepEqual(sent[0][1], { triggerTurn: false });
});

test("send return while caller is streaming uses follow-up queueing", async () => {
  const userMessages = [];

  await deliverReturnToCaller({
    pi: {
      sendUserMessage: (text, options) => userMessages.push({ text, options }),
    },
    ctx: {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "caller" },
      isIdle: () => false,
    },
    callerSessionManager: { appendMessage() {} },
    text: "Queued answer",
    invoke: true,
  });

  assert.deepEqual(userMessages[0], {
    text: "Queued answer",
    options: { deliverAs: "followUp" },
  });
});

test("synchronous send return is queued as steering before the caller continues", async () => {
  const userMessages = [];

  await deliverReturnToCaller({
    pi: {
      sendUserMessage: () => {
        throw new Error("visible session should be used");
      },
    },
    ctx: {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "caller" },
      isIdle: () => false,
    },
    callerSessionId: "caller",
    callerSessionManager: { appendMessage() {} },
    text: "Synchronous answer",
    invoke: true,
    queue: "steer",
    visibleSession: {
      sendUserMessage: async (text, options) =>
        userMessages.push({ text, options }),
    },
  });

  assert.deepEqual(userMessages[0], {
    text: "Synchronous answer",
    options: { deliverAs: "steer" },
  });
});

test("target final answer is displayed when that target session is visible", async () => {
  const sent = [];
  const delivered = await displayTargetAnswerIfVisible({
    ctx: {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "target" },
    },
    target: {
      session: {
        sendCustomMessage: (...args) => sent.push(args),
        sessionManager: { appendCustomMessageEntry() {} },
      },
    },
    targetSessionId: "target",
    text: "final text",
  });

  assert.equal(delivered, true);

  assert.equal(sent[0][0].content, "Final answer from this session:\nfinal text");

  assert.deepEqual(sent[0][1], { triggerTurn: false });
});

test("target final answer is not displayed in unrelated visible sessions", async () => {
  const sent = [];
  const delivered = await displayTargetAnswerIfVisible({
    ctx: {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "other" },
    },
    target: {
      session: {
        sendCustomMessage: (...args) => sent.push(args),
        sessionManager: { appendCustomMessageEntry() {} },
      },
    },
    targetSessionId: "target",
    text: "final text",
  });

  assert.equal(delivered, false);

  assert.deepEqual(sent, []);
});

test("send return persists when the captured caller is no longer active", async () => {
  const appended = [];
  const mode = await deliverReturnToCaller({
    pi: {
      sendMessage: () => {
        throw new Error("should not deliver to visible session");
      },
      sendUserMessage: () => {
        throw new Error("should not invoke visible session");
      },
    },
    ctx: {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "visible-other" },
    },
    callerSessionId: "caller",
    callerSessionManager: {
      appendCustomMessageEntry: (...args) => appended.push(args),
    },
    text: "Returned answer",
    invoke: false,
  });

  assert.equal(mode, "persisted");

  assert.deepEqual(appended[0], [
    "pi-gentic:return-context",
    "Returned answer",
    true,
    { kind: "returnContext" },
  ]);
});

test("send return invokes stale caller sessions through the background delivery hook", async () => {
  const appended = [];
  const invoked = [];
  const mode = await deliverReturnToCaller({
    pi: {
      sendUserMessage: () => {
        throw new Error("stale");
      },
    },
    ctx: {
      get cwd() {
        throw new Error("stale context");
      },
      sessionManager: { getSessionId: () => "caller" },
    },
    callerSessionId: "caller",
    callerSessionManager: {
      appendMessage: (message) => appended.push(message),
    },
    text: "Returned answer",
    invoke: true,
    invokeInactiveCaller: async (text) => invoked.push(text),
  });

  assert.equal(mode, "background");

  assert.deepEqual(invoked, ["Returned answer"]);

  assert.deepEqual(appended, []);
});

test("worktree preparation uses cwd as folder and empty worktree as branch from folder", async () => {
  const repo = createGitRepo();
  const worktree = path.join(
    mkdtempSync(path.join(tmpdir(), "pi-gentic-worktree-parent-")),
    "task-branch",
  );

  const resolved = await prepareWorktree({
    repoCwd: repo,
    message: "Implement task",
    cwd: worktree,
    worktree: "",
  });

  assert.equal(resolved, worktree);

  assert.equal(existsSync(path.join(worktree, ".git")), true);

  const defaultWorktree = await prepareWorktree({
    repoCwd: repo,
    message: "Add Default Folder",
    worktree: "",
  });

  assert.equal(
    defaultWorktree.startsWith(path.join(repo, ".agentfiles", "worktrees")),
    true,
  );

  assert.equal(existsSync(path.join(defaultWorktree, ".git")), true);
});

test("worktree preparation can use an explicit absolute source repository", async () => {
  const caller = mkdtempSync(path.join(tmpdir(), "pi-gentic-caller-"));
  const repo = createGitRepo();

  const resolved = await prepareWorktree({
    repoCwd: caller,
    repo,
    message: "Use Source Repo",
    worktree: "",
  });

  assert.equal(
    resolved.startsWith(path.join(repo, ".agentfiles", "worktrees")),
    true,
  );

  assert.equal(existsSync(path.join(resolved, ".git")), true);
});

test("worktree preparation resolves relative repositories from the caller cwd", async () => {
  const caller = mkdtempSync(path.join(tmpdir(), "pi-gentic-caller-"));
  const repo = createGitRepo(path.join(caller, "source-"));
  const relativeRepo = path.relative(caller, repo);

  const resolved = await prepareWorktree({
    repoCwd: caller,
    repo: relativeRepo,
    cwd: "trees/relative-target",
    worktree: "relative-target",
  });

  assert.equal(resolved, path.join(repo, "trees", "relative-target"));

  assert.equal(existsSync(path.join(resolved, ".git")), true);
});

test("worktree preparation reports non-git repositories clearly", async () => {
  const caller = mkdtempSync(path.join(tmpdir(), "pi-gentic-caller-"));

  await assert.rejects(
    () => prepareWorktree({ repoCwd: caller, repo: ".", worktree: "task" }),
    /Worktree repository must be a git repository:/,
  );
});

test("send confirmation tells callers not to wait or duplicate delegated work", () => {
  const text = sendConfirmationText(
    "researcher",
    "019ecdce-4317-701b-9c51-1b05272f0db0",
    "check that",
  );

  assert.match(text, /Do not wait for it to return/);

  assert.match(text, /do not duplicate the delegated work yourself/);
});

test("queued send confirmation explains that the target session is busy", () => {
  const text = sendPendingText({
    async: true,
    agentName: "researcher",
    sessionId: "019ecdce-4317-701b-9c51-1b05272f0db0",
    message: "continue",
    details: { status: "queued" },
  });

  assert.match(text, /Queued message for \[researcher\] agent/);

  assert.match(text, /already working and will read this message when ready/);
});

test("abort actor is always defined for caller and agent sessions", () => {
  assert.equal(
    abortActor({ sessionManager: { getEntries: () => [] } }),
    "caller session",
  );

  assert.equal(
    abortActor({
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "pi-gentic:state",
            data: { agentName: "researcher" },
          },
        ],
      },
    }),
    "[researcher] agent",
  );
});

test("sessions that stop without an answer keep a stopped status", () => {
  const outcome = sessionRunOutcome(
    {
      agentName: "researcher",
      session: {
        sessionManager: {
          getSessionId: () => "019ecdce-4317-701b-9c51-1b05272f0db0",
        },
        agent: { state: { messages: [{ role: "assistant", content: "" }] } },
      },
    },
    { request: "continue" },
  );

  assert.equal(outcome.status, "stopped");

  assert.match(outcome.text, /stopped before returning a final answer/);
});

test("session status keeps running duration stable and explains queued messages", () => {
  const originalNow = Date.now;

  try {
    Date.now = () => 1_000_000;
    const runtime = {
      agentName: "researcher",
      createdAt: new Date(940_000).toISOString(),
      session: {
        isStreaming: true,
        pendingMessageCount: 2,
        sessionManager: {
          getSessionId: () => "019ecdce-4317-701b-9c51-1b05272f0db0",
        },
        agent: { state: { messages: [] } },
      },
    };

    const first = sessionStatus(runtime);
    Date.now = () => 1_010_000;
    const second = sessionStatus(runtime);

    assert.equal(first.runningMs, 60_000);
    assert.equal(second.runningMs, 70_000);
    assert.match(second.text, /State: running/);
    assert.match(second.text, /Queued messages: 2/);
  } finally {
    Date.now = originalNow;
  }
});

test("formatted status is readable instead of raw JSON", () => {
  const text = formatSessionStatus({
    sessionId: "019ecdce-4317-701b-9c51-1b05272f0db0",
    agentName: "researcher",
    state: "idle",
    inactiveText: "5s",
    pendingMessages: 0,
    lastActivities: [],
  });

  assert.match(text, /Session 019ecdce \[researcher\]/);

  assert.doesNotMatch(text, /^\{/);
});

test("send completion policy supports deferred foreground commands without changing tool defaults", () => {
  assert.equal(
    shouldDeferSendCompletion({ async: true, awaitCompletion: true }),
    true,
  );

  assert.equal(
    shouldDeferSendCompletion({ async: false, awaitCompletion: false }),
    true,
  );

  assert.equal(
    shouldDeferSendCompletion({ async: false, awaitCompletion: undefined }),
    false,
  );
});

test("agent availability has a reusable core boundary", () => {
  const config = {
    settings: {
      agentDefaults: {},
      agentlessSession: { agents: ["researcher"] },
      globalMaxSubagentDepth: 6,
    },
    agents: [{ name: "researcher" }, { name: "reviewer" }],
  };
  const policy = resolveSessionPolicy({
    settings: config.settings,
    allAgents: config.agents.map((agent) => agent.name),
    allTools: ["agents"],
    allSkills: [],
  });
  const agents = filterAvailableAgents(config, policy);

  assert.equal(assertAvailableAgent("researcher", agents).name, "researcher");

  assert.throws(
    () => assertAvailableAgent("reviewer", agents),
    /Unavailable agent/,
  );
});
