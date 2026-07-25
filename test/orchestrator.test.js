import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyFilterList } from "../dist/catalog.js";
import {
  availableAgentLines,
  filterSkillPrompt,
} from "../dist/catalog.js";
import {
  abortActor,
  createSessionActivityMonitor,
  contextStillActive,
  deliverCardToCaller,
  deliverReturnToCaller,
  deliverSendContextToCaller,
  lastRuntimeActivities,
  persistAgentCardState,
} from "../dist/orchestration.js";
import {
  isTargetSlashCommand,
  prepareTargetPromptForSend,
  resolveReturnDelivery,
  sendConfirmationText,
  sendPendingText,
  sendStatusText,
  sendUserMessageOptions,
  shouldDeferSendCompletion,
  slashCommandDeliveryText,
  promptSessionAndWaitForTurnEnd,
} from "../dist/orchestration.js";
import { sessionRunOutcome } from "../dist/orchestration.js";
import { formatSessionStatus, sessionStatus } from "../dist/orchestration.js";
import { assertAvailableAgent, filterAvailableAgents } from "../dist/catalog.js";
import { resolveSessionPolicy } from "../dist/catalog.js";
import { PiGenticOrchestrator, prepareWorktree } from "../dist/orchestration.js";
import { deleteRuntimeSession, setRuntimeSession } from "../dist/pi-host.js";

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

test("terminal card persistence validates snapshots and copies activities", () => {
  assert.equal(persistAgentCardState({}, { status: "done" }), false);
  assert.equal(
    persistAgentCardState({}, { cardId: "card", status: "running" }),
    false,
  );
  assert.equal(
    persistAgentCardState({}, { cardId: "card", status: "done" }),
    false,
  );
  assert.equal(
    persistAgentCardState(
      { appendCustomEntry() {} },
      { cardId: "invalid", status: "done", invalid: () => undefined },
    ),
    false,
  );

  const entries = [];
  const activities = [{ type: "tool", name: "read" }];
  let persisted = 0;
  assert.equal(
    persistAgentCardState(
      { appendCustomEntry: (...args) => entries.push(args) },
      { cardId: "valid", status: "done", activities },
      () => persisted++,
    ),
    true,
  );
  assert.equal(persisted, 1);
  assert.notEqual(entries[0][1].activities, activities);
  assert.deepEqual(entries[0][1].activities, activities);
});

test("send status text classifies every terminal and active state", () => {
  assert.equal(
    sendStatusText({ status: "done", agentName: "reviewer" }),
    "Agent reviewer answered.",
  );
  assert.equal(sendStatusText({ status: "queued" }), "Queued message for agent.");
  assert.equal(
    sendStatusText({ status: "stopped" }),
    "Agent stopped before answering.",
  );
  assert.equal(
    sendStatusText({ status: "stopped", error: "limit" }),
    "limit",
  );
  assert.equal(sendStatusText({ status: "error" }), "Agent call failed.");
  assert.equal(sendStatusText({}), "Sending message to agent...");
});

test("send pending text handles foreground and agentless background deliveries", () => {
  assert.equal(
    sendPendingText({ async: false, details: { status: "done" } }),
    "Agent answered.",
  );
  const background = sendConfirmationText(
    undefined,
    undefined,
    "delegate",
  );
  assert.match(background, /^Sent message to agent in session \./);
  assert.match(background, /full answer/);
  assert.deepEqual(resolveReturnDelivery({ awaitCompletion: true }), {
    kind: "toolResult",
  });
  assert.deepEqual(resolveReturnDelivery({ awaitCompletion: false }), {
    kind: "callerMessage",
    queue: "steer",
  });
});

test("send context delivery respects caller liveness and absorbs stale APIs", () => {
  let sent;
  const target = {
    agentName: "reviewer",
    session: { sessionManager: { getSessionId: () => "target" } },
  };

  deliverSendContextToCaller({
    pi: { sendMessage: (message, options) => (sent = { message, options }) },
    ctx: { isIdle: () => true },
    target,
    message: "review",
    async: true,
    fork: false,
  });
  assert.equal(sent.message.details.sessionId, "target");
  assert.deepEqual(sent.options, { triggerTurn: false });

  sent = undefined;
  deliverSendContextToCaller({
    pi: { sendMessage: () => assert.fail("busy caller received context") },
    ctx: { isIdle: () => false },
    target,
  });
  assert.equal(sent, undefined);
  assert.doesNotThrow(() =>
    deliverSendContextToCaller({
      pi: { sendMessage: () => { throw new Error("stale"); } },
      ctx: { isIdle: () => true },
      target,
    }),
  );
});

test("message options and context liveness tolerate stale native contexts", () => {
  assert.deepEqual(sendUserMessageOptions({ isIdle: () => false }), {
    deliverAs: "followUp",
  });
  assert.equal(sendUserMessageOptions({ isIdle: () => true }), undefined);
  assert.equal(
    sendUserMessageOptions({ isIdle: () => { throw new Error("stale"); } }),
    undefined,
  );
  assert.equal(
    contextStillActive(
      { cwd: process.cwd(), sessionManager: { getSessionId: () => "caller" } },
      "caller",
    ),
    true,
  );
  assert.equal(
    contextStillActive(
      { cwd: process.cwd(), sessionManager: { getSessionId: () => "other" } },
      "caller",
    ),
    false,
  );
  assert.equal(
    contextStillActive({
      get cwd() { throw new Error("stale"); },
      sessionManager: { getSessionId: () => "caller" },
    }),
    false,
  );
});

test("prompt skill content stays native while agent descriptions remain policy-scoped", () => {
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
  const prompt = `${filterSkillPrompt(basePrompt, [], ["tdd"])}\n${availableAgentLines(
    [
      { name: "researcher", description: "Finds reliable context" },
      { name: "builder", description: "Builds patches" },
    ],
    ["researcher"],
  )}`;

  assert.match(prompt, /<available_skills>/);

  assert.match(prompt, /<name>tdd<\/name>/);

  assert.match(prompt, /<location>C:\/skills\/tdd\/SKILL\.md<\/location>/);

  assert.match(prompt, /frontend-design/);

  assert.match(prompt, /researcher: Finds reliable context/);
});

test("runtime session references reject ambiguous shared prefixes", async () => {
  const firstSessionId = "019faaaa-1111-7111-8111-111111111111";
  const secondSessionId = "019faaaa-2222-7222-8222-222222222222";
  const runtime = (sessionId) => ({
    session: { sessionManager: { getSessionId: () => sessionId } },
  });

  setRuntimeSession(firstSessionId, runtime(firstSessionId));
  setRuntimeSession(secondSessionId, runtime(secondSessionId));

  try {
    const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [] });

    await assert.rejects(
      () =>
        orchestrator.getOrOpenSession(
          {
            cwd: process.cwd(),
            sessionManager: { getSessionDir: () => process.cwd() },
          },
          "019faaaa",
        ),
      /Ambiguous session reference/, 
    );
  } finally {
    deleteRuntimeSession(firstSessionId);
    deleteRuntimeSession(secondSessionId);
  }
});

test("target command prompts keep slash commands and attach caller context", async () => {
  const customMessages = [];
  const session = {
    isStreaming: false,
    promptTemplates: [{ name: "review" }],
    resourceLoader: { getSkills: () => ({ skills: [{ name: "tdd" }] }) },
    sendCustomMessage: (...args) => customMessages.push(args),
  };

  assert.equal(isTargetSlashCommand("/review staged", session), true);

  assert.equal(isTargetSlashCommand("/skill:tdd add coverage", session), true);

  assert.equal(isTargetSlashCommand("/send nested", session), false);

  const prompt = await prepareTargetPromptForSend(
    session,
    "/review staged",
    "Message from agent from session caller",
  );

  assert.equal(prompt.text, "/review staged");

  assert.equal(prompt.command.source, "prompt");

  assert.equal(customMessages[0][0].customType, "pi-gentic:send-context");

  assert.equal(customMessages[0][1].deliverAs, "nextTurn");
});

test("extension slash commands are recognized without command-specific code", async () => {
  const customMessages = [];
  const session = {
    createReplacedSessionContext: () => ({
      getCommands: () => [
        { name: "goal", source: "extension", description: "Complete goal" },
      ],
    }),
    sendCustomMessage: (...args) => customMessages.push(args),
  };

  assert.equal(isTargetSlashCommand("/goal done", session), true);

  const prompt = await prepareTargetPromptForSend(
    session,
    "/goal done",
    "Message from agent from session caller",
  );

  assert.equal(prompt.text, "/goal done");

  assert.equal(prompt.command.source, "extension");

  assert.equal(slashCommandDeliveryText(prompt.command, "019eabcd-0000"), "Command /goal delivered to session 019eabcd.");

  assert.deepEqual(customMessages, []);
});

test("busy target command prompts steer context before queuing slash command", async () => {
  const customMessages = [];
  const session = {
    isStreaming: true,
    promptTemplates: [{ name: "review" }],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    sendCustomMessage: (...args) => customMessages.push(args),
  };

  const prompt = await prepareTargetPromptForSend(
    session,
    "/review staged",
    "Message from agent from session caller",
  );

  assert.equal(prompt.text, "/review staged");

  assert.equal(customMessages[0][1].deliverAs, "steer");
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

test("aborted async sends persist terminal failures after the caller extension becomes stale", async () => {
  const callerSessionId = "stale-caller";
  const targetSessionId = "aborted-target";
  const persistedMessages = [];
  const targetMessages = [];
  let stale = false;
  let rejectPrompt;
  let markPromptStarted;
  let markSettled;
  const promptStarted = new Promise((resolve) => {
    markPromptStarted = resolve;
  });
  const settled = new Promise((resolve) => {
    markSettled = resolve;
  });
  const callerSessionManager = {
    getSessionId: () => callerSessionId,
    getEntries: () => [],
    appendCustomEntry() {},
    appendCustomMessageEntry: (...args) => persistedMessages.push(args),
  };
  const target = {
    agentName: "researcher",
    session: {
      isStreaming: false,
      agent: { state: { messages: targetMessages } },
      sessionManager: { getSessionId: () => targetSessionId },
      prompt: () =>
        new Promise((_resolve, reject) => {
          rejectPrompt = reject;
          markPromptStarted();
        }),
      abort: async () => {},
    },
  };
  const orchestrator = new PiGenticOrchestrator({
    getAllTools: () => [],
    sendMessage: () => {
      if (stale) throw new Error(staleContextError);
    },
  });
  orchestrator.load = () => ({});
  orchestrator.resolvePolicy = () => ({ agentsTool: {} });
  orchestrator.resolveTargetSession = async () => target;
  orchestrator.invokeCallerSession = async () => {
    throw new Error("Caller session unavailable.");
  };

  try {
    await orchestrator.send(
      {
        cwd: process.cwd(),
        sessionManager: callerSessionManager,
        isIdle: () => true,
      },
      { message: "Research Pi updates", async: true },
      { onSettled: markSettled },
    );
    await promptStarted;
    stale = true;
    targetMessages.push({ role: "assistant", content: "", stopReason: "aborted" });
    rejectPrompt(new Error("Agent call aborted."));
    await settled;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(persistedMessages.length, 1);
    assert.equal(persistedMessages[0][0], "pi-gentic:card");
    assert.match(persistedMessages[0][1], /Caller session unavailable/);
    assert.equal(persistedMessages[0][3].status, "error");
  } finally {
    deleteRuntimeSession(targetSessionId);
  }
});

test("deferred completion uses one visible context message to invoke the live caller", async () => {
  const sent = [];
  const mode = await deliverCardToCaller({
    pi: { sendMessage() {} },
    ctx: {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "caller" },
    },
    callerSessionId: "caller",
    callerSessionManager: { appendCustomMessageEntry() {} },
    text: "Agent answer",
    details: { cardId: "send:child:1", status: "done" },
    invoke: true,
    visibleSession: {
      sessionManager: { getSessionId: () => "caller" },
      sendCustomMessage: (...args) => sent.push(args),
    },
  });

  assert.equal(mode, "live");
  assert.deepEqual(sent, [
    [
      {
        customType: "pi-gentic:card",
        content: "Agent answer",
        display: true,
        details: { cardId: "send:child:1", status: "done" },
      },
      { triggerTurn: true },
    ],
  ]);
});

test("deferred completion steers the same visible card into a running caller", async () => {
  const sent = [];

  await deliverCardToCaller({
    pi: { sendMessage() {} },
    ctx: {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "caller" },
    },
    callerSessionId: "caller",
    callerSessionManager: { appendCustomMessageEntry() {} },
    text: "Agent answer",
    details: { cardId: "send:child:1", status: "done" },
    invoke: true,
    queue: "steer",
    visibleSession: {
      isStreaming: true,
      sessionManager: { getSessionId: () => "caller" },
      sendCustomMessage: (...args) => sent.push(args),
    },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].customType, "pi-gentic:card");
  assert.equal(sent[0][0].content, "Agent answer");
  assert.deepEqual(sent[0][1], { deliverAs: "steer" });
});

test("deferred completion invokes an inactive caller with the same canonical card", async () => {
  const invoked = [];
  const persisted = [];
  const mode = await deliverCardToCaller({
    pi: { sendMessage() {} },
    ctx: {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "visible-other" },
    },
    callerSessionId: "caller",
    callerSessionManager: {
      appendCustomMessageEntry: (...args) => persisted.push(args),
    },
    text: "Agent answer",
    details: { cardId: "send:child:1", status: "done" },
    invoke: true,
    invokeInactiveCaller: (message) => invoked.push(message),
  });

  assert.equal(mode, "background");
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0].customType, "pi-gentic:card");
  assert.equal(invoked[0].content, "Agent answer");
  assert.deepEqual(persisted, []);
});

test("deferred completion cards persist in their original caller session", async () => {
  const entries = [];
  let persisted = 0;
  const sessionManager = {
    appendCustomMessageEntry: (...args) => entries.push(args),
  };
  const mode = await deliverCardToCaller({
    pi: { sendMessage() {} },
    ctx: {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "visible-other" },
    },
    callerSessionId: "caller",
    callerSessionManager: sessionManager,
    text: "Agent answer",
    details: { cardId: "send:child:1", status: "done" },
    persist: (value) => {
      assert.equal(value, sessionManager);
      persisted += 1;
    },
  });

  assert.equal(mode, "persisted");
  assert.deepEqual(entries, [
    [
      "pi-gentic:card",
      "Agent answer",
      true,
      { cardId: "send:child:1", status: "done" },
    ],
  ]);
  assert.equal(persisted, 1);
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

test("live user delivery defaults to follow-up without an explicit return policy", async () => {
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

test("synchronous return policy stays at the tool result boundary", () => {
  assert.deepEqual(resolveReturnDelivery({ async: false }), {
    kind: "toolResult",
  });
});

test("async return delivery steers the caller at the next model boundary", async () => {
  const delivery = resolveReturnDelivery({ async: true });
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
    text: "Async answer",
    invoke: true,
    queue: delivery.queue,
    visibleSession: {
      sendUserMessage: async (text, options) =>
        userMessages.push({ text, options }),
    },
  });

  assert.deepEqual(userMessages[0], {
    text: "Async answer",
    options: { deliverAs: "steer" },
  });
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

test("no-invoke return steers into a running caller without opening a new run", async () => {
  const delivered = [];
  const callerSessionId = "running-caller";
  setRuntimeSession(callerSessionId, {
    session: {
      isStreaming: true,
      sessionManager: { getSessionId: () => callerSessionId },
      sendUserMessage: async (...args) => delivered.push(args),
    },
  });

  try {
    const mode = await deliverReturnToCaller({
      pi: { sendMessage() {}, sendUserMessage() {} },
      ctx: {
        cwd: process.cwd(),
        sessionManager: { getSessionId: () => "visible-other" },
      },
      callerSessionId,
      callerSessionManager: { appendCustomMessageEntry() {} },
      text: "child answer",
      invoke: false,
      persist: () => {
        throw new Error("should not persist while caller is running");
      },
      visibleSession: undefined,
      queue: "steer",
    });

    assert.equal(mode, "live");

    assert.deepEqual(delivered, [["child answer", { deliverAs: "steer" }]]);
  } finally {
    deleteRuntimeSession(callerSessionId);
  }
});

test("send return invokes inactive registered caller sessions through the background delivery hook", async () => {
  const callerSessionId = "inactive-registered-caller";
  const sent = [];
  const invoked = [];
  setRuntimeSession(callerSessionId, {
    session: {
      isStreaming: false,
      sessionManager: { getSessionId: () => callerSessionId },
      sendUserMessage: (...args) => sent.push(args),
    },
  });

  try {
    const mode = await deliverReturnToCaller({
      pi: { sendUserMessage() {}, sendMessage() {} },
      ctx: {
        cwd: process.cwd(),
        sessionManager: { getSessionId: () => "visible-child" },
      },
      callerSessionId,
      callerSessionManager: { appendMessage() {} },
      text: "Returned answer",
      invoke: true,
      queue: "steer",
      visibleSession: {
        sessionManager: { getSessionId: () => "visible-child" },
      },
      invokeInactiveCaller: async (text) => invoked.push(text),
    });

    assert.equal(mode, "background");
    assert.deepEqual(sent, []);
    assert.deepEqual(invoked, ["Returned answer"]);
  } finally {
    deleteRuntimeSession(callerSessionId);
  }
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
    queue: "steer",
    invokeInactiveCaller: async (text) => invoked.push(text),
  });

  assert.equal(mode, "background");

  assert.deepEqual(invoked, ["Returned answer"]);

  assert.deepEqual(appended, []);
});

const staleContextError =
  "This extension ctx is stale after session replacement or reload.";

test("foreground send waits for the native session to settle after recoverable agent runs", async () => {
  let listener;
  let resolved = false;
  const session = {
    subscribe: (next) => {
      listener = next;
      return () => {};
    },
  };
  const completed = promptSessionAndWaitForTurnEnd(
    session,
    () => new Promise(() => {}),
  ).then(() => {
    resolved = true;
  });

  await Promise.resolve();
  listener?.({ type: "agent_end" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(resolved, false);

  listener?.({ type: "compaction_start", reason: "overflow" });
  listener?.({ type: "agent_end" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(resolved, false);

  listener?.({ type: "agent_settled" });
  await completed;
  assert.equal(resolved, true);
});

test("settlement tracking preserves later live UI event listeners", async () => {
  const listeners = [];
  const session = {
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);

        if (index !== -1) listeners.splice(index, 1);
      };
    },
  };
  const completed = promptSessionAndWaitForTurnEnd(
    session,
    () => new Promise(() => {}),
  );

  await Promise.resolve();
  const visibleEvents = [];
  session.subscribe((event) => visibleEvents.push(event.type));

  for (const listener of listeners) listener({ type: "agent_settled" });
  await completed;

  assert.deepEqual(visibleEvents, ["agent_settled"]);
});

test("foreground send also completes from the native prompt promise", async () => {
  let unsubscribed = false;
  const session = {
    subscribe: () => () => {
      unsubscribed = true;
    },
  };

  await promptSessionAndWaitForTurnEnd(session, async () => {});

  assert.equal(unsubscribed, true);
});

test("send return skips a stale visible session before starting a caller turn", async () => {
  const invoked = [];
  let visibleMessages = 0;
  const mode = await deliverReturnToCaller({
    pi: {
      sendUserMessage: () => {
        throw new Error("stale pi should not be used");
      },
    },
    ctx: {
      get cwd() {
        throw new Error(staleContextError);
      },
      sessionManager: { getSessionId: () => "caller" },
    },
    callerSessionId: "caller",
    callerSessionManager: { appendMessage() {} },
    text: "Returned answer",
    invoke: true,
    queue: "steer",
    visibleSession: {
      sessionManager: { getSessionId: () => "caller" },
      createReplacedSessionContext: () => ({
        get cwd() {
          throw new Error(staleContextError);
        },
        sessionManager: { getSessionId: () => "caller" },
      }),
      sendUserMessage: () => {
        visibleMessages += 1;
      },
    },
    invokeInactiveCaller: async (text) => invoked.push(text),
  });

  assert.equal(mode, "background");
  assert.equal(visibleMessages, 0);
  assert.deepEqual(invoked, ["Returned answer"]);
});

test("prompt append ignores stale extension contexts during session replacement", () => {
  const orchestrator = new PiGenticOrchestrator({
    getAllTools: () => [],
  });

  assert.equal(
    orchestrator.buildPromptAppend(
      {
        get cwd() {
          throw new Error(staleContextError);
        },
        sessionManager: { getSessionId: () => "caller" },
      },
      { systemPrompt: "Base prompt" },
    ),
    undefined,
  );
});

test("worktree preparation uses cwd as folder and empty worktree as branch from folder", async () => {
  const repo = createGitRepo();
  const worktreeParent = mkdtempSync(
    path.join(tmpdir(), "pi-gentic-worktree-parent-"),
  );
  const worktree = path.join(worktreeParent, "task-branch");

  const resolved = await prepareWorktree({
    repoCwd: repo,
    message: "Implement task",
    cwd: worktree,
    worktree: "",
    allowedWorktreeRoots: [worktreeParent],
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

  assert.match(text, /session 019ecdce-4317-701b-9c51-1b05272f0db0/);

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

test("aborted child outcomes are delivered back so parent sessions can continue", async () => {
  const userMessages = [];
  const outcome = sessionRunOutcome(
    {
      agentName: "worker",
      session: {
        sessionManager: { getSessionId: () => "child-session" },
        agent: {
          state: {
            messages: [
              {
                role: "assistant",
                content: "",
                stopReason: "aborted",
              },
            ],
          },
        },
      },
    },
    { request: "do work" },
  );

  assert.equal(outcome.status, "aborted");

  await deliverReturnToCaller({
    pi: {
      sendUserMessage: (text, options) => userMessages.push({ text, options }),
    },
    ctx: {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "parent" },
      isIdle: () => false,
    },
    callerSessionId: "parent",
    callerSessionManager: { appendMessage() {} },
    text: outcome.text,
    invoke: true,
    queue: "steer",
  });

  assert.match(userMessages[0].text, /was aborted while handling your request/);

  assert.deepEqual(userMessages[0].options, { deliverAs: "steer" });
});

test("sessions that stop at the output limit report the stop reason and recent model error", () => {
  const outcome = sessionRunOutcome(
    {
      agentName: "researcher",
      session: {
        sessionManager: {
          getSessionId: () => "019ecdce-4317-701b-9c51-1b05272f0db0",
        },
        agent: {
          state: {
            messages: [
              {
                role: "assistant",
                content: "",
                stopReason: "error",
                errorMessage: "Input exceeds the context window.",
              },
              { role: "assistant", content: "", stopReason: "length" },
            ],
          },
        },
      },
    },
    { request: "continue" },
  );

  assert.equal(outcome.status, "stopped");
  assert.match(outcome.text, /stopped before returning a final answer/);
  assert.match(outcome.text, /output token limit/i);
  assert.match(outcome.text, /Recent model error: Input exceeds the context window\./);
});

test("activity monitors reset inactivity for lifecycle and reasoning progress", () => {
  const originalNow = Date.now;
  const published = [];

  try {
    Date.now = () => 1_000;
    const monitor = createSessionActivityMonitor(
      { status: "running", updatedAt: 100 },
      (details) => {
        published.push(details);
        return details;
      },
    );

    monitor.observe({ type: "agent_start" });
    assert.equal(published.at(-1).updatedAt, 1_000);
    assert.deepEqual(published.at(-1).activities, []);

    Date.now = () => 2_000;
    monitor.observe({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "still working" }],
      },
    });
    assert.equal(published.at(-1).updatedAt, 2_000);
    assert.deepEqual(published.at(-1).activities, []);
  } finally {
    Date.now = originalNow;
  }
});

test("activity monitors preserve the completed answer in terminal card state", () => {
  const published = [];
  const monitor = createSessionActivityMonitor(
    { status: "running", updatedAt: 100 },
    (details) => {
      published.push(details);
      return details;
    },
  );

  const completed = monitor.finish({
    answer: "Final agent answer",
    activities: [{ type: "tool", name: "write", summary: "result.json" }],
  });

  assert.equal(completed.status, "done");
  assert.equal(completed.answer, "Final agent answer");
  assert.equal(published.at(-1).answer, "Final agent answer");
});

test("queued activity monitors ignore the target's current run until the queued turn starts", () => {
  const published = [];
  const monitor = createSessionActivityMonitor(
    { status: "queued", updatedAt: 100 },
    (details) => {
      published.push(details);
      return details;
    },
  );

  monitor.observe({
    type: "tool_execution_start",
    toolCallId: "current-run-tool",
    toolName: "read",
    args: {},
  });
  assert.deepEqual(published, []);

  monitor.observe({
    type: "message_start",
    message: { role: "user", content: "queued request" },
  });
  assert.equal(published.at(-1).status, "running");
  assert.deepEqual(published.at(-1).activities, []);

  monitor.observe({
    type: "tool_execution_start",
    toolCallId: "queued-run-tool",
    toolName: "write",
    args: { path: "result.txt" },
  });
  assert.deepEqual(
    published.at(-1).activities.map((activity) => activity.id),
    ["queued-run-tool"],
  );
});

test("runtime activity history merges cached and current session activities", () => {
  const runtime = {
    lastActivities: [
      {
        id: "cached-tool",
        type: "tool",
        name: "read",
        summary: "cached",
        status: "done",
      },
    ],
    session: {
      agent: {
        state: {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "current answer" },
                {
                  type: "toolCall",
                  id: "current-tool",
                  name: "write",
                  arguments: { path: "result.txt" },
                },
              ],
            },
          ],
        },
      },
    },
  };

  assert.deepEqual(
    lastRuntimeActivities(runtime).map((activity) => activity.id),
    ["assistant", "current-tool", "cached-tool"],
  );
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

test("named child sessions activate with the current Pi model runtime", async () => {
  const sessionId = "019fmodel-1111-7111-8111-111111111111";
  const selectedModel = {
    provider: "openai-codex",
    id: "gpt-5.6-sol",
  };
  const entries = [];
  const appliedModels = [];
  const session = {
    modelRuntime: {
      getModel: (provider, id) =>
        provider === selectedModel.provider && id === selectedModel.id
          ? selectedModel
          : undefined,
      getModels: () => [selectedModel],
      getAvailableSnapshot: () => [selectedModel],
    },
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    sessionManager: {
      appendCustomEntry: (customType, data) =>
        entries.push({ type: "custom", customType, data }),
      getEntries: () => entries,
      getSessionId: () => sessionId,
    },
    getAllTools: () => [],
    setActiveToolsByName: () => undefined,
    setModel: async (model) => appliedModels.push(model),
    setThinkingLevel: () => undefined,
  };
  const config = {
    settings: {
      agentDefaults: {},
      agentlessSession: {},
      globalMaxSubagentDepth: 6,
    },
    agents: [
      {
        name: "researcher",
        model: "gpt-5.6-sol",
        thinking: "high",
      },
    ],
  };
  const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [] });

  try {
    await orchestrator.loadAgentIntoSession(
      session,
      "researcher",
      undefined,
      config,
    );

    assert.deepEqual(appliedModels, [selectedModel]);
    assert.deepEqual(entries.at(-1)?.data, {
      agentName: "researcher",
      overrides: undefined,
    });
  } finally {
    deleteRuntimeSession(sessionId);
  }
});
