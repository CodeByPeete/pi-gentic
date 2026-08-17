import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyFilterList } from "../dist/catalog.js";
import { availableAgentLines, filterSkillPrompt } from "../dist/catalog.js";
import {
  abortActor,
  branchForkBeforeDelegation,
  collectSessionActivities,
  createSessionActivityMonitor,
  contextStillActive,
  deliverCardToCaller,
  deliverReturnToCaller,
  deliverSendContextToCaller,
  deliverToLiveCaller,
  lastRuntimeActivities,
  persistReturnForCaller,
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
import {
  deleteRuntimeSession,
  hasJoinedDelegations,
  loadPiCodingAgentPeer,
  registerAgentCall,
  setRuntimeSession,
} from "../dist/pi-host.js";
import { createExtensionRuntime } from "../dist/runtime/ExtensionRuntime.js";
import { clearLiveCardDetails, getLiveCardDetails } from "../dist/ui.js";

const effectRuntime = createExtensionRuntime();
test.after(() => effectRuntime.dispose());

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

function callerContext(sessionId) {
  return {
    cwd: process.cwd(),
    isIdle: () => true,
    sessionManager: {
      appendCustomEntry() {},
      getEntries: () => [],
      getSessionFile: () => `${sessionId}.jsonl`,
      getSessionId: () => sessionId,
    },
  };
}

function deferredTarget(sessionId, answer) {
  const messages = [];
  const completion = Promise.withResolvers();
  const target = {
    session: {
      agent: { state: { messages } },
      isStreaming: false,
      sessionManager: {
        appendCustomMessageEntry() {},
        getSessionId: () => sessionId,
      },
      prompt: async () => {
        await completion.promise;
        messages.push({ role: "assistant", content: answer, stopReason: "stop" });
      },
      abort: async () => {},
    },
  };

  return { target, finish: completion.resolve };
}

function orchestratorForTarget(target) {
  const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [], sendMessage: () => {} }, effectRuntime);

  orchestrator.load = () => ({});
  orchestrator.resolvePolicy = () => ({ agentsTool: {} });
  orchestrator.resolveTargetSession = async () => target;
  orchestrator.deliverCallerCard = async () => "background";
  return orchestrator;
}

test("terminal card persistence validates snapshots and copies activities", () => {
  assert.equal(persistAgentCardState({}, { status: "done" }), false);
  assert.equal(persistAgentCardState({}, { cardId: "card", status: "running" }), false);
  assert.equal(persistAgentCardState({}, { cardId: "card", status: "done" }), false);
  assert.equal(
    persistAgentCardState({ appendCustomEntry() {} }, { cardId: "invalid", status: "done", invalid: () => undefined }),
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

  const longActivities = Array.from({ length: 20 }, (_, index) => ({
    id: `activity-${index}`,
    type: "tool",
    name: "read",
  }));
  const compactEntries = [];
  assert.equal(
    persistAgentCardState(
      { appendCustomEntry: (...args) => compactEntries.push(args) },
      { cardId: "compact", status: "done", activities: longActivities },
    ),
    true,
  );
  assert.equal(compactEntries[0][1].activityCount, 20);
  assert.deepEqual(
    compactEntries[0][1].activities.map(({ id }) => id),
    longActivities.slice(-14).map(({ id }) => id),
  );

  const assistantActivities = collectSessionActivities({
    agent: {
      state: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Created the file." }],
          },
          { role: "system", content: "ignored" },
        ],
      },
    },
  });
  const assistantEntries = [];

  assert.deepEqual(assistantActivities, [{ id: "assistant", type: "assistant", text: "Created the file." }]);
  assert.equal(
    persistAgentCardState(
      { appendCustomEntry: (...args) => assistantEntries.push(args) },
      {
        cardId: "assistant-activity",
        status: "done",
        activities: assistantActivities,
      },
    ),
    true,
  );
});

test("send status text classifies every terminal and active state", () => {
  assert.equal(sendStatusText({ status: "done", agentName: "reviewer" }), "Agent reviewer answered.");
  assert.equal(sendStatusText({ status: "queued" }), "Queued message for agent.");
  assert.equal(sendStatusText({ status: "stopped" }), "Agent stopped before answering.");
  assert.equal(sendStatusText({ status: "stopped", error: "limit" }), "limit");
  assert.equal(sendStatusText({ status: "error" }), "Agent call failed.");
  assert.equal(sendStatusText({}), "Sending message to agent...");
});

test("send pending text handles foreground and agentless background deliveries", () => {
  assert.equal(sendPendingText({ async: false, details: { status: "done" } }), "Agent answered.");
  const background = sendConfirmationText(undefined, undefined, "delegate");
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
      pi: {
        sendMessage: () => {
          throw new Error("stale");
        },
      },
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
    sendUserMessageOptions({
      isIdle: () => {
        throw new Error("stale");
      },
    }),
    undefined,
  );
  assert.equal(
    contextStillActive({ cwd: process.cwd(), sessionManager: { getSessionId: () => "caller" } }, "caller"),
    true,
  );
  assert.equal(
    contextStillActive({ cwd: process.cwd(), sessionManager: { getSessionId: () => "other" } }, "caller"),
    false,
  );
  assert.equal(
    contextStillActive({
      get cwd() {
        throw new Error("stale");
      },
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
    const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [] }, effectRuntime);

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

test("caller delivery boundaries contain stale and persistence failures", async () => {
  assert.equal(
    await deliverCardToCaller({
      pi: { sendMessage: () => {} },
      ctx: { sessionManager: { getSessionId: () => "other" } },
      callerSessionId: "caller",
      callerSessionManager: {
        appendCustomMessageEntry: () => {
          throw new Error("read only");
        },
      },
      text: "Return",
      details: {},
      invoke: false,
    }),
    "unavailable",
  );

  assert.deepEqual(
    await deliverToLiveCaller({
      pi: {
        sendMessage: () => {
          throw new Error("stale api");
        },
      },
      ctx: { sessionManager: { getSessionId: () => "caller" } },
      callerSessionId: "caller",
      text: "Return",
      invoke: false,
    }),
    { delivered: false },
  );
  assert.deepEqual(
    await deliverToLiveCaller({
      pi: { sendMessage: () => {} },
      ctx: { sessionManager: { getSessionId: () => "caller" } },
      callerSessionId: "caller",
      visibleSession: {
        sessionManager: {
          getSessionId: () => {
            throw new Error("stale session");
          },
        },
      },
      text: "Return",
      invoke: false,
    }),
    { delivered: true, mode: "live" },
  );

  const appended = [];
  persistReturnForCaller({
    callerSessionManager: { appendMessage: (message) => appended.push(message) },
    text: "Invoke",
    invoke: true,
  });
  persistReturnForCaller({
    callerSessionManager: {
      appendCustomMessageEntry: (...args) => appended.push(args),
    },
    text: "Persist",
    invoke: false,
  });
  assert.equal(appended.length, 2);
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

  const prompt = await prepareTargetPromptForSend(session, "/review staged", "Message from agent from session caller");

  assert.equal(prompt.text, "/review staged");

  assert.equal(prompt.command.source, "prompt");

  assert.equal(customMessages[0][0].customType, "pi-gentic:send-context");

  assert.equal(customMessages[0][1].deliverAs, "nextTurn");
});

test("extension slash commands are recognized without command-specific code", async () => {
  const customMessages = [];
  const session = {
    createReplacedSessionContext: () => ({
      getCommands: () => [{ name: "goal", source: "extension", description: "Complete goal" }],
    }),
    sendCustomMessage: (...args) => customMessages.push(args),
  };

  assert.equal(isTargetSlashCommand("/goal done", session), true);

  const prompt = await prepareTargetPromptForSend(session, "/goal done", "Message from agent from session caller");

  assert.equal(prompt.text, "/goal done");

  assert.equal(prompt.command.source, "extension");

  assert.equal(
    slashCommandDeliveryText(prompt.command, "019eabcd-0000"),
    "Command /goal delivered to session 019eabcd.",
  );

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

  const prompt = await prepareTargetPromptForSend(session, "/review staged", "Message from agent from session caller");

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

test("aborted async sends preserve target failures after caller invocation fails", async () => {
  const callerSessionId = "stale-caller";
  const targetSessionId = "aborted-target";
  const persistedMessages = [];
  const targetMessages = [];
  let stale = false;
  let targetAborted = false;
  let rejectPrompt;
  let markPromptStarted;
  const controller = new AbortController();
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
  const callerContext = {
    cwd: process.cwd(),
    get sessionManager() {
      if (stale) throw new Error(staleContextError);
      return callerSessionManager;
    },
    isIdle: () => true,
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
      abort: async () => {
        targetAborted = true;
        rejectPrompt?.(new Error("Agent call aborted."));
        throw new Error("Target abort cleanup failed.");
      },
    },
  };
  const orchestrator = new PiGenticOrchestrator(
    {
      getAllTools: () => [],
      sendMessage: () => {
        if (stale) throw new Error(staleContextError);
      },
    },
    effectRuntime,
  );
  orchestrator.load = () => ({});
  orchestrator.resolvePolicy = () => ({ agentsTool: {} });
  orchestrator.resolveTargetSession = async () => target;
  orchestrator.invokeCallerSession = async () => {
    throw new Error("Caller session unavailable.");
  };

  try {
    await orchestrator.send(
      callerContext,
      { message: "Research Pi updates", async: true },
      { onSettled: markSettled, signal: controller.signal },
    );
    await promptStarted;
    stale = true;
    targetMessages.push({ role: "assistant", content: "", stopReason: "aborted" });
    controller.abort();
    await settled;
    assert.equal(targetAborted, true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(persistedMessages.length, 1);
    assert.equal(persistedMessages[0][0], "pi-gentic:card");
    assert.match(persistedMessages[0][1], /was aborted while handling your request/);
    assert.doesNotMatch(persistedMessages[0][1], /Caller session unavailable/);
    assert.equal(persistedMessages[0][3].status, "aborted");
  } finally {
    deleteRuntimeSession(targetSessionId);
  }
});

test("foreground sends complete through the managed delegation runtime", async () => {
  const messages = [];
  const delegationMarkers = [];
  const listeners = new Set();
  let unsubscribed = false;
  const session = {
    agent: { state: { messages } },
    isStreaming: true,
    sessionManager: {
      appendCustomMessageEntry: (...args) => delegationMarkers.push(args),
      getSessionId: () => "foreground-target",
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribed = true;
      };
    },
    prompt: async () => {
      for (const listener of listeners)
        listener({
          type: "message_update",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Foreground answer" }],
          },
        });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Foreground answer" }],
        stopReason: "stop",
      });
      queueMicrotask(() => {
        for (const listener of listeners) listener({ type: "agent_settled" });
      });
      setTimeout(() => {
        session.isStreaming = false;
        for (const listener of listeners) listener({ type: "agent_settled" });
      }, 10);
    },
    abort: async () => {},
  };
  const target = { agentName: "researcher", session };
  const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [], sendMessage: () => {} }, effectRuntime);
  orchestrator.load = () => ({});
  orchestrator.resolvePolicy = () => ({ agentsTool: {} });
  orchestrator.resolveTargetSession = async () => target;
  const updates = [];
  const refreshes = [];

  try {
    const result = await orchestrator.send(
      {
        cwd: process.cwd(),
        isIdle: () => true,
        sessionManager: {
          getEntries: () => [],
          getSessionFile: () => "foreground-caller.jsonl",
          getSessionId: () => "foreground-caller",
        },
      },
      { message: "Complete this synchronously", async: false },
      {
        call: {
          toolCallId: "foreground-call",
          callerEntryId: "foreground-entry",
          parameters: { action: "send", message: "Complete this synchronously", async: false },
        },
        onRefresh: (details) => refreshes.push(details),
        onUpdate: (update) => updates.push(update),
      },
    );

    assert.match(result.text, /Foreground answer/);
    assert.equal(result.details.answer, "Foreground answer");
    assert.equal(result.details.status, "done");
    assert.equal(unsubscribed, true);
    assert.equal(updates.length, 1);
    assert.ok(refreshes.some((details) => details.status === "done"));
    assert.equal(delegationMarkers.length, 1);
    assert.match(delegationMarkers[0][1], /Delegated from session/);
    assert.deepEqual(delegationMarkers[0][3].call, {
      toolCallId: "foreground-call",
      callerEntryId: "foreground-entry",
      parameters: { action: "send", message: "Complete this synchronously", async: false },
      effectiveParameters: {
        action: "send",
        message: "Complete this synchronously",
        async: false,
        fork: false,
        cwd: process.cwd(),
      },
    });
  } finally {
    deleteRuntimeSession("foreground-target");
  }
});

test("send returns the resumed target answer after invoked nested work settles", async () => {
  const targetSessionId = "hierarchical-target";
  const nestedSessionId = "hierarchical-nested";
  const initialMessages = [];
  const finalMessages = [
    {
      role: "assistant",
      content: "Final answer informed by nested work",
      stopReason: "stop",
    },
  ];
  const nestedFinished = Promise.withResolvers();
  let nestedCall;
  const sessionManager = {
    appendCustomMessageEntry() {},
    getSessionId: () => targetSessionId,
  };
  const target = {
    agentName: "coordinator",
    session: {
      agent: { state: { messages: initialMessages } },
      isStreaming: false,
      sessionManager,
      prompt: async () => {
        nestedCall = registerAgentCall({
          callerSessionId: targetSessionId,
          targetSessionId: nestedSessionId,
          joinsCallerCompletion: true,
        });
        initialMessages.push({
          role: "assistant",
          content: "Waiting for nested work",
          stopReason: "stop",
        });
        void nestedFinished.promise.then(() => {
          target.session = {
            ...target.session,
            agent: { state: { messages: finalMessages } },
          };
          nestedCall.unregister();
        });
      },
      abort: async () => {},
    },
  };
  const orchestrator = orchestratorForTarget(target);
  const resultPromise = orchestrator.send(callerContext("hierarchical-caller"), {
    message: "Coordinate nested work",
    async: false,
  });
  let returned = false;
  void resultPromise.then(() => {
    returned = true;
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(returned, false);

    nestedFinished.resolve();
    const result = await resultPromise;

    assert.match(result.text, /Final answer informed by nested work/);
  } finally {
    nestedCall?.unregister();
    deleteRuntimeSession(targetSessionId);
  }
});

test("background send joins caller completion unless explicitly detached", async () => {
  const callerSessionId = "joining-caller";
  const targetSessionId = "joining-target";
  const { target, finish } = deferredTarget(targetSessionId, "Nested answer");
  const orchestrator = orchestratorForTarget(target);
  const settled = Promise.withResolvers();

  try {
    await orchestrator.send(
      callerContext(callerSessionId),
      { message: "Nested work", async: true, invokeMeLater: true },
      { onSettled: settled.resolve },
    );

    assert.equal(hasJoinedDelegations(callerSessionId), true);
    finish();
    await settled.promise;
    assert.equal(hasJoinedDelegations(callerSessionId), false);
  } finally {
    deleteRuntimeSession(targetSessionId);
  }
});

test("detached background send does not join caller completion", async () => {
  const callerSessionId = "detached-caller";
  const targetSessionId = "detached-target";
  const { target, finish } = deferredTarget(targetSessionId, "Detached answer");
  const orchestrator = orchestratorForTarget(target);
  const settled = Promise.withResolvers();

  try {
    await orchestrator.send(
      callerContext(callerSessionId),
      { message: "Detached work", async: true, invokeMeLater: false },
      { onSettled: settled.resolve },
    );

    assert.equal(hasJoinedDelegations(callerSessionId), false);
    finish();
    await settled.promise;
  } finally {
    deleteRuntimeSession(targetSessionId);
  }
});

test("background sends survive extension reload and leave the live panel terminal", async () => {
  const targetSessionId = "background-target";
  const messages = [];
  const deliveries = [];
  const runtime = createExtensionRuntime();
  let finishTarget;
  const targetCanFinish = new Promise((resolve) => {
    finishTarget = resolve;
  });
  let settle;
  const settled = new Promise((resolve) => {
    settle = resolve;
  });
  const target = {
    agentName: "builder",
    session: {
      agent: { state: { messages } },
      isStreaming: false,
      sessionManager: { getSessionId: () => targetSessionId },
      prompt: async () => {
        await targetCanFinish;
        messages.push({
          role: "assistant",
          content: "Background answer",
          stopReason: "stop",
        });
      },
      abort: async () => {},
    },
  };
  const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [], sendMessage: () => {} }, runtime);
  orchestrator.load = () => ({});
  orchestrator.resolvePolicy = () => ({ agentsTool: {} });
  orchestrator.resolveTargetSession = async () => target;
  orchestrator.deliverCallerCard = async (_ctx, delivery) => {
    deliveries.push(delivery);
    return "background";
  };
  let pending;

  try {
    pending = await orchestrator.send(
      {
        cwd: process.cwd(),
        isIdle: () => true,
        sessionManager: {
          appendCustomEntry: () => {},
          getEntries: () => [],
          getSessionId: () => "background-caller",
        },
      },
      { message: "Complete this in the background", async: true },
      { onSettled: settle },
    );
    const disposal = runtime.disposeWhenIdle();

    finishTarget();
    await settled;
    await disposal;

    assert.match(pending.text, /background|builder/i);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].details.status, "done");
    assert.match(deliveries[0].text, /Background answer/);
    assert.equal(getLiveCardDetails(pending.details)?.status, "done");
  } finally {
    if (pending) clearLiveCardDetails(pending.details);
    await runtime.dispose();
    deleteRuntimeSession(targetSessionId);
  }
});

test("background target errors invoke unopened caller sessions with the provider error", async () => {
  const targetSessionId = "background-error-target";
  const callerSessionManager = {
    appendCustomEntry() {},
    appendCustomMessageEntry() {},
    getCwd: () => process.cwd(),
    getEntries: () => [],
    getSessionFile: () => "caller.jsonl",
    getSessionId: () => "background-error-caller",
  };
  const otherSessionManager = { getSessionId: () => "visible-other" };
  let visibleSessionManager = callerSessionManager;
  let finishTarget;
  const targetCanFinish = new Promise((resolve) => {
    finishTarget = resolve;
  });
  const messages = [];
  const target = {
    agentName: "researcher",
    session: {
      agent: { state: { messages } },
      isStreaming: false,
      sessionManager: {
        appendCustomMessageEntry() {},
        getSessionId: () => targetSessionId,
      },
      prompt: async () => {
        await targetCanFinish;
        messages.push({
          role: "assistant",
          content: "",
          stopReason: "error",
          errorMessage: "Codex stream ended after output began and cannot be continued from its incomplete response.",
          diagnostics: [
            {
              type: "provider_stream_failure",
              error: { message: "Your input exceeds the context window of this model." },
            },
          ],
        });
      },
      abort: async () => {},
    },
  };
  const callerDeliveries = [];
  let settle;
  const settled = new Promise((resolve) => {
    settle = resolve;
  });
  const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [], sendMessage: () => {} }, effectRuntime);
  orchestrator.load = () => ({});
  orchestrator.resolvePolicy = () => ({ agentsTool: {} });
  orchestrator.resolveTargetSession = async () => target;
  orchestrator.applyPolicyToAgentSession = async () => {};
  orchestrator.createRuntimeForSessionManager = async (sessionManager) => ({
    session: {
      isStreaming: false,
      isIdle: true,
      sessionManager,
      sendCustomMessage: (...args) => {
        callerDeliveries.push(args);
        return Promise.resolve();
      },
    },
  });
  const ctx = {
    cwd: process.cwd(),
    isIdle: () => true,
    get sessionManager() {
      return visibleSessionManager;
    },
  };

  try {
    await orchestrator.send(
      ctx,
      { message: "Research this in the background", async: true, invokeMeLater: true },
      { onSettled: settle },
    );
    visibleSessionManager = otherSessionManager;
    finishTarget();
    await settled;

    assert.equal(callerDeliveries.length, 1);
    assert.match(callerDeliveries[0][0].content, /Your input exceeds the context window of this model\./);
    assert.doesNotMatch(callerDeliveries[0][0].content, /cannot be continued/);
    assert.deepEqual(callerDeliveries[0][1], { triggerTurn: true });
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

test("deferred completion preserves the original card when inactive caller invocation fails", async () => {
  const persisted = [];
  const mode = await deliverCardToCaller({
    pi: { sendMessage() {} },
    ctx: { sessionManager: { getSessionId: () => "visible-other" } },
    callerSessionId: "caller",
    callerSessionManager: {
      appendCustomMessageEntry: (...args) => persisted.push(args),
    },
    text: "Target context limit exceeded",
    details: { cardId: "send:child:1", status: "error" },
    invoke: true,
    invokeInactiveCaller: async () => {
      throw new Error("caller invocation failed");
    },
  });

  assert.equal(mode, "persisted");
  assert.deepEqual(persisted, [
    ["pi-gentic:card", "Target context limit exceeded", true, { cardId: "send:child:1", status: "error" }],
  ]);
});

test("deferred completion cards persist bounded activity history in their original caller session", async () => {
  const entries = [];
  let persisted = 0;
  const sessionManager = {
    appendCustomMessageEntry: (...args) => entries.push(args),
  };
  const activities = Array.from({ length: 20 }, (_, index) => ({ id: `activity-${index}`, type: "tool" }));
  const mode = await deliverCardToCaller({
    pi: { sendMessage() {} },
    ctx: {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "visible-other" },
    },
    callerSessionId: "caller",
    callerSessionManager: sessionManager,
    text: "Agent answer",
    details: { cardId: "send:child:1", status: "done", activities },
    persist: (value) => {
      assert.equal(value, sessionManager);
      persisted += 1;
    },
  });

  assert.equal(mode, "persisted");
  assert.equal(entries[0][0], "pi-gentic:card");
  assert.equal(entries[0][1], "Agent answer");
  assert.equal(entries[0][2], true);
  assert.equal(entries[0][3].activityCount, 20);
  assert.deepEqual(
    entries[0][3].activities.map(({ id }) => id),
    activities.slice(-14).map(({ id }) => id),
  );
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
      sendUserMessage: async (text, options) => userMessages.push({ text, options }),
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

  assert.deepEqual(appended[0], ["pi-gentic:return-context", "Returned answer", true, { kind: "returnContext" }]);
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

const staleContextError = "This extension ctx is stale after session replacement or reload.";

test("foreground send waits for the native session to settle after recoverable agent runs", async () => {
  let listener;
  let resolved = false;
  const session = {
    subscribe: (next) => {
      listener = next;
      return () => {};
    },
  };
  const completed = promptSessionAndWaitForTurnEnd(session, effectRuntime, () => new Promise(() => {})).then(() => {
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
  const completed = promptSessionAndWaitForTurnEnd(session, effectRuntime, () => new Promise(() => {}));

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

  await promptSessionAndWaitForTurnEnd(session, effectRuntime, async () => {});

  assert.equal(unsubscribed, true);
});

test("foreground prompt tracking preserves failures, aborts, and sessions without subscriptions", async () => {
  assert.equal(await promptSessionAndWaitForTurnEnd({}, effectRuntime, async () => "native result"), "native result");

  let unsubscribed = 0;
  const session = {
    subscribe: () => () => unsubscribed++,
  };
  await assert.rejects(
    promptSessionAndWaitForTurnEnd(session, effectRuntime, async () => {
      throw new Error("prompt failed");
    }),
    /prompt failed/,
  );

  const controller = new AbortController();
  const aborted = promptSessionAndWaitForTurnEnd(
    session,
    effectRuntime,
    () => new Promise(() => {}),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(aborted, /Agent call aborted/);
  assert.equal(unsubscribed, 2);
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
  const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [] }, effectRuntime);
  const ctx = {
    get cwd() {
      throw new Error(staleContextError);
    },
    sessionManager: { getSessionId: () => "caller" },
  };

  assert.equal(orchestrator.prepareVisibleTurn(ctx), undefined);
  assert.equal(orchestrator.buildPromptAppend(ctx, { systemPrompt: "Base prompt" }), undefined);
});

test("visible tool policy runs before prompts and after model changes", async () => {
  let activeTools = ["exec_command", "agents"];
  const toolWrites = [];
  let runtimePreferenceWrites = 0;
  const orchestrator = new PiGenticOrchestrator(
    {
      getAllTools: () => ["exec_command", "agents"].map((name) => ({ name })),
      getActiveTools: () => activeTools,
      setActiveTools: (selection) => {
        activeTools = selection;
        toolWrites.push(selection);
      },
      setModel: async () => {
        runtimePreferenceWrites++;
        activeTools = ["exec_command", "agents"];
      },
      setThinkingLevel: () => runtimePreferenceWrites++,
    },
    effectRuntime,
  );
  const ctx = {
    cwd: process.cwd(),
    mode: "rpc",
    getSystemPromptOptions: () => ({ skills: [] }),
    isProjectTrusted: () => false,
    modelRegistry: { getAvailable: () => [{ provider: "openai", id: "unused" }] },
    sessionManager: { getEntries: () => [] },
    ui: {},
  };

  orchestrator.load = () => ({
    agents: [],
    roots: [],
    settings: {
      agentDefaults: {},
      agentlessSession: { tools: ["agents"], model: "unused", thinking: "high" },
    },
  });

  orchestrator.prepareVisibleTurn(ctx);
  assert.deepEqual(orchestrator.buildPromptAppend(ctx, { systemPrompt: "Base prompt" }), {
    systemPrompt: "Base prompt",
  });
  assert.deepEqual(orchestrator.applyPolicySnapshot(ctx).policy.resources.tools, ["agents"]);
  assert.deepEqual(toolWrites, [["agents"]]);
  assert.equal(runtimePreferenceWrites, 0);

  await orchestrator.applyCurrentPolicy(ctx);
  assert.deepEqual(activeTools, ["agents"]);
  assert.equal(runtimePreferenceWrites, 2);
});

test("orchestrator routes target, status, abort, and policy operations", async () => {
  const sessionId = "019fbbbb-1111-7111-8111-111111111111";
  const target = {
    session: {
      agent: { state: { messages: [] } },
      isStreaming: false,
      abort: async () => {
        target.aborted = true;
      },
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => [],
      },
    },
    createdAt: new Date().toISOString(),
  };
  const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [] }, effectRuntime);
  const ctx = {
    cwd: process.cwd(),
    abort: () => {
      ctx.aborted = true;
    },
    sessionManager: {
      getSessionId: () => "caller-session",
      getEntries: () => [],
    },
  };

  const model = { provider: "provider", id: "model" };
  assert.equal(orchestrator.resolveModel({ modelRegistry: { find: () => model } }, "provider/model"), model);
  await assert.rejects(() => orchestrator.status(ctx), /sessionId.*required/);
  orchestrator.getOrOpenSession = async () => target;
  assert.equal((await orchestrator.status(ctx, sessionId)).sessionId, sessionId);
  assert.match(await orchestrator.abort(ctx), /caller-s/);
  assert.equal(ctx.aborted, true);
  assert.match(await orchestrator.abort(ctx, sessionId), /019fbbbb/);
  assert.equal(target.aborted, true);

  const operations = [];
  orchestrator.assertCanMessageSession = async () => operations.push("message");
  orchestrator.applyRequestedTargetPolicy = async () => operations.push("policy");
  assert.equal(
    await orchestrator.resolveTargetSession(ctx, { sessionId, cwd: ctx.cwd, message: "existing" }, {}),
    target,
  );
  assert.deepEqual(operations, ["message", "policy"]);

  operations.length = 0;
  orchestrator.createChildSession = async () => target;
  orchestrator.applyAgentlessPolicyToNewSession = async () => operations.push("agentless");
  await orchestrator.resolveTargetSession(ctx, { message: "new" }, {});
  assert.deepEqual(operations, ["policy", "agentless"]);

  const policyOrchestrator = new PiGenticOrchestrator({ getAllTools: () => [] }, effectRuntime);
  policyOrchestrator.loadAgentIntoSession = async () => operations.push("agent");
  policyOrchestrator.applySessionOverrides = async () => operations.push("overrides");
  await policyOrchestrator.applyRequestedTargetPolicy(target.session, { agent: "builder" }, {});
  await policyOrchestrator.applyRequestedTargetPolicy(target.session, { overrides: { thinking: "high" } }, {});
  assert.deepEqual(operations.slice(-2), ["agent", "overrides"]);

  assert.equal(await orchestrator.resolveSendCwd(ctx, { cwd: "chosen" }), "chosen");
  orchestrator.prepareWorktree = async () => "worktree";
  assert.equal(await orchestrator.resolveSendCwd(ctx, { worktree: "branch" }), "worktree");
  assert.deepEqual(Object.keys(orchestrator.cardDetails("send", "done")).sort(), ["kind", "status", "updatedAt"]);
});

test("forked children exclude the caller's unfinished delegation turn", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-gentic-fork-boundary-"));
  const { SessionManager } = await loadPiCodingAgentPeer();

  try {
    const parent = SessionManager.create(root, root);
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    parent.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Earlier caller question" }],
      timestamp: Date.now(),
    });
    const forkBoundaryEntryId = parent.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Retained caller context" }],
      api: "test",
      provider: "test",
      model: "test",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
    parent.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Delegate the current request" }],
      timestamp: Date.now(),
    });
    const callerEntryId = parent.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "delegation-call",
          name: "agents",
          arguments: { action: "send", fork: true, message: "Research this" },
        },
      ],
      api: "test",
      provider: "test",
      model: "test",
      usage,
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    const child = SessionManager.forkFrom(parent.getSessionFile(), root, root);
    const unmatchedChild = SessionManager.forkFrom(parent.getSessionFile(), root, root);

    assert.equal(
      branchForkBeforeDelegation(child, {
        callerEntryId,
        forkBoundaryEntryId,
        toolCallId: "delegation-call",
      }),
      true,
    );
    child.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Message from parent: Research this" }],
      timestamp: Date.now(),
    });

    const messages = child.buildSessionContext().messages;
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant", "user"],
    );
    assert.equal(messages[1].content[0].text, "Retained caller context");
    assert.equal(child.getEntry(callerEntryId).message.content[0].type, "toolCall");

    assert.equal(
      branchForkBeforeDelegation(unmatchedChild, {
        callerEntryId,
        forkBoundaryEntryId,
        toolCallId: "another-call",
      }),
      false,
    );
    assert.deepEqual(
      unmatchedChild.buildSessionContext().messages.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orchestrator rejects messages that close an active delegation cycle", async () => {
  const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [] }, effectRuntime);
  const activeCall = registerAgentCall({ callerSessionId: "parent", targetSessionId: "child" });
  const target = {
    session: {
      sessionManager: {
        getSessionId: () => "parent",
      },
    },
  };

  orchestrator.getOrOpenSession = async () => target;

  try {
    await assert.rejects(
      orchestrator.resolveTargetSession(
        {
          sessionManager: {
            getSessionId: () => "child",
          },
        },
        { message: "Reply to parent", sessionId: "parent" },
        {},
      ),
      /active delegation cycle/,
    );
  } finally {
    activeCall.unregister();
  }
});

test("orchestrator creates native child and fork session runtimes", async () => {
  const peer = await loadPiCodingAgentPeer();
  const originals = {
    create: peer.SessionManager.create,
    forkFrom: peer.SessionManager.forkFrom,
    createAgentSessionServices: peer.createAgentSessionServices,
    createAgentSessionFromServices: peer.createAgentSessionFromServices,
    createAgentSessionRuntime: peer.createAgentSessionRuntime,
  };
  let createdManager;
  let forkedManager;
  const forkOperations = [];
  const manager = (sessionId) => ({
    appendSessionInfo: () => {
      if (sessionId === "forked-child") forkOperations.push("session-info");
    },
    branch: (entryId) => forkOperations.push(`branch:${entryId}`),
    flush: () => {},
    getCwd: () => process.cwd(),
    getEntries: () => [],
    getEntry: (entryId) => {
      if (sessionId !== "forked-child") return undefined;
      if (entryId !== "delegation-entry") return undefined;
      return {
        id: entryId,
        parentId: "unfinished-turn-entry",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "delegation-call", name: "agents" }],
        },
      };
    },
    getLeafId: () => (sessionId === "forked-child" ? "delegation-entry" : undefined),
    getSessionFile: () => `${sessionId}.jsonl`,
    getSessionId: () => sessionId,
  });
  peer.SessionManager.create = () => (createdManager = manager("created-child"));
  peer.SessionManager.forkFrom = () => (forkedManager = manager("forked-child"));
  peer.createAgentSessionServices = async () => ({ diagnostics: [] });
  peer.createAgentSessionFromServices = async ({ sessionManager }) => ({
    session: { sessionManager, isStreaming: false },
  });
  peer.createAgentSessionRuntime = async (createRuntime, options) => createRuntime(options);
  const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [] }, effectRuntime);
  orchestrator.assertCanCreateChildSession = async () => {};
  const ctx = {
    cwd: process.cwd(),
    sessionManager: {
      flush: () => {},
      getSessionDir: () => process.cwd(),
      getSessionFile: () => "parent.jsonl",
      getSessionId: () => "parent-session",
    },
  };

  try {
    const created = await orchestrator.createChildSession(ctx, { message: "create child" }, {});
    assert.equal(created.session.sessionManager, createdManager);
    assert.equal(created.parentSessionId, "parent-session");
    assert.equal(created.parentSessionPath, "parent.jsonl");

    const forked = await orchestrator.createChildSession(
      ctx,
      { message: "fork child", fork: true },
      {},
      {
        call: {
          callerEntryId: "delegation-entry",
          forkBoundaryEntryId: "completed-conversation-entry",
          toolCallId: "delegation-call",
        },
      },
    );
    assert.equal(forked.session.sessionManager, forkedManager);
    assert.deepEqual(forkOperations, ["branch:completed-conversation-entry", "session-info"]);

    const reopened = await orchestrator.createRuntimeForSessionManager(manager("registered-runtime"), process.cwd());
    assert.equal(reopened.session.sessionManager.getSessionId(), "registered-runtime");
  } finally {
    Object.assign(peer.SessionManager, {
      create: originals.create,
      forkFrom: originals.forkFrom,
    });
    Object.assign(peer, {
      createAgentSessionServices: originals.createAgentSessionServices,
      createAgentSessionFromServices: originals.createAgentSessionFromServices,
      createAgentSessionRuntime: originals.createAgentSessionRuntime,
    });
    deleteRuntimeSession("created-child");
    deleteRuntimeSession("forked-child");
    deleteRuntimeSession("registered-runtime");
  }
});

test("orchestrator invokes registered caller runtimes with structured returns", async () => {
  const sessionId = "019fffff-1111-7111-8111-111111111111";
  const sent = [];
  const persisted = [];
  const callerSessionManager = {
    appendCustomMessageEntry: (...args) => persisted.push(args),
    getCwd: () => process.cwd(),
    getEntries: () => [],
    getSessionId: () => sessionId,
  };
  const existing = {
    session: {
      isStreaming: true,
      sessionManager: callerSessionManager,
      sendCustomMessage: async (message, options) => sent.push({ message, options }),
    },
  };
  const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [] }, effectRuntime);
  orchestrator.applyPolicyToAgentSession = async () => {};
  setRuntimeSession(sessionId, existing);

  try {
    await orchestrator.invokeCallerSession({
      callerSessionManager,
      callerCwd: process.cwd(),
      message: {
        customType: "pi-gentic:return-context",
        content: "Return answer",
        display: true,
      },
      config: {},
      queue: "followUp",
    });
    assert.equal(sent.length, 1);
    assert.equal(existing.lastMessage, "Return answer");
    await assert.rejects(
      () =>
        orchestrator.invokeCallerSession({
          callerSessionManager,
          message: { content: "invalid" },
          config: {},
        }),
      /structured Pi message/,
    );

    existing.session.sendCustomMessage = async () => {
      throw new Error("return failed");
    };
    await orchestrator.invokeCallerSession({
      callerSessionManager,
      message: {
        customType: "pi-gentic:return-context",
        content: "Failure",
        display: true,
      },
      config: {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(persisted.at(-1)[0], "pi-gentic:return-invoke-error");

    const inactiveDeliveries = [];
    orchestrator.runtimeForCallerInvocation = async () => ({
      session: {
        isStreaming: false,
        isIdle: true,
        sessionManager: callerSessionManager,
        sendCustomMessage: (...args) => {
          inactiveDeliveries.push(args);
          return Promise.resolve();
        },
      },
    });
    await orchestrator.invokeCallerSession({
      callerSessionManager,
      callerCwd: process.cwd(),
      message: {
        customType: "pi-gentic:return-context",
        content: "Inactive return",
        display: true,
      },
      config: {},
    });
    assert.deepEqual(inactiveDeliveries, [
      [
        {
          customType: "pi-gentic:return-context",
          content: "Inactive return",
          display: true,
        },
        { triggerTurn: true },
      ],
    ]);
    delete orchestrator.runtimeForCallerInvocation;

    orchestrator.createRuntimeForSessionManager = async () => ({ fresh: true });
    assert.deepEqual(
      await orchestrator.runtimeForCallerInvocation({
        existing: { session: { isStreaming: false } },
        callerSessionManager,
      }),
      { fresh: true },
    );
  } finally {
    deleteRuntimeSession(sessionId);
  }
});

test("orchestrator applies runtime policy and discovers the current session", async () => {
  const runtime = createExtensionRuntime();
  const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [] }, runtime);
  const model = { provider: "openai", id: "gpt-test" };
  const calls = [];
  const session = {
    getAllTools: () => [{ name: "read" }],
    getActiveToolNames: () => [],
    modelRuntime: { getAvailable: () => [model] },
    resourceLoader: { getSkills: () => ({ skills: [{ name: "debug" }] }) },
    sessionManager: { getEntries: () => [] },
    setActiveToolsByName: (tools) => calls.push(["tools", tools]),
    setModel: async (selected) => calls.push(["model", selected]),
    setThinkingLevel: (level) => calls.push(["thinking", level]),
  };
  orchestrator.resolveAgentSessionPolicy = () => ({
    model: "gpt-test",
    thinking: "high",
    toolFilters: ["read"],
    resources: { tools: ["read"], agents: [], skills: [] },
  });

  await orchestrator.applyPolicyToAgentSession(session, {});
  assert.deepEqual(calls, [
    ["model", model],
    ["thinking", "high"],
    ["tools", ["read"]],
  ]);

  const depthOrchestrator = new PiGenticOrchestrator({ getAllTools: () => [] }, effectRuntime);
  depthOrchestrator.currentSessionDepth = async () => 1;
  depthOrchestrator.resolvePolicy = () => ({ maxSubagentDepth: 2 });
  await assert.doesNotReject(() =>
    depthOrchestrator.assertCanCreateChildSession({}, { settings: { globalMaxSubagentDepth: 3 } }),
  );
  await depthOrchestrator.assertCanMessageSession({}, {}, { settings: { sessionMessagingScope: "all" } });

  const overrideEntries = [];
  const overrideSession = {
    sessionManager: {
      appendCustomEntry: (customType, data) => overrideEntries.push({ type: "custom", customType, data }),
      getEntries: () => [
        {
          type: "custom",
          customType: "pi-gentic:state",
          data: { agentName: "reviewer" },
        },
      ],
      getSessionId: () => "override-session",
    },
  };
  orchestrator.applyPolicyToAgentSession = async () => "applied";
  assert.equal(await orchestrator.applySessionOverrides(overrideSession, { thinking: "high" }, {}), "applied");
  assert.equal(overrideEntries.at(-1).data.agentName, "reviewer");
  await assert.rejects(
    () => orchestrator.loadAgentIntoSession(overrideSession, "missing", undefined, { agents: [] }),
    /Unknown agent/,
  );

  const policyOrchestrator = new PiGenticOrchestrator({ getAllTools: () => [] }, effectRuntime);
  const resolvedPolicy = policyOrchestrator.resolveAgentSessionPolicy(
    {
      getAllTools: () => [{ name: "read" }],
      resourceLoader: { getSkills: () => ({ skills: [{ name: "debug" }] }) },
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "pi-gentic:state",
            data: { agentName: "reviewer", overrides: { thinking: "high" } },
          },
        ],
      },
    },
    {
      settings: { agentDefaults: {}, agentlessSession: {} },
      agents: [{ name: "reviewer", tools: ["read"] }],
    },
  );
  assert.equal(resolvedPolicy.agentName, "reviewer");
  assert.equal(resolvedPolicy.thinking, "high");

  assert.doesNotThrow(() =>
    policyOrchestrator.resolvePolicy(
      {
        getSystemPromptOptions: () => {
          throw new Error("stale skill context");
        },
      },
      {
        settings: { agentDefaults: {}, agentlessSession: {} },
        agents: [],
      },
      {},
    ),
  );
  const prompt = policyOrchestrator.resolvedPromptForCard(
    {
      cwd: process.cwd(),
      getSystemPrompt: () => {
        throw new Error("stale prompt");
      },
      getSystemPromptOptions: () => ({ skills: [] }),
      isProjectTrusted: () => false,
    },
    { agents: [], settings: {} },
    {
      resources: { agents: [], skills: [], tools: [] },
      systemPromptFiles: [],
    },
    undefined,
  );
  assert.equal(typeof prompt, "string");

  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-discover-"));
  const ctx = {
    cwd: dir,
    sessionManager: {
      getEntries: () => [],
      getHeader: () => ({}),
      getSessionDir: () => dir,
      getSessionFile: () => path.join(dir, "current.jsonl"),
      getSessionId: () => "019fcccc-1111-7111-8111-111111111111",
      getSessionName: () => "Current",
    },
  };
  orchestrator.load = () => ({});
  orchestrator.resolvePolicy = () => ({ agentsTool: { rx: 0, ry: 0 } });

  try {
    assert.equal(await orchestrator.currentSessionDepth(ctx), 0);
    const result = await orchestrator.discoverSessions(ctx, {});
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].sessionId, "019fcccc-1111-7111-8111-111111111111");
    assert.deepEqual([result.rx, result.ry], [0, 0]);
  } finally {
    await runtime.dispose();
  }
});

test("worktree preparation uses cwd as folder and empty worktree as branch from folder", async () => {
  const repo = createGitRepo();
  const worktreeParent = mkdtempSync(path.join(tmpdir(), "pi-gentic-worktree-parent-"));
  const worktree = path.join(worktreeParent, "task-branch");
  const runtime = createExtensionRuntime();
  const orchestrator = new PiGenticOrchestrator({}, runtime);

  const resolved = await orchestrator.resolveSendCwd(
    { cwd: repo },
    {
      message: "Implement task",
      cwd: worktree,
      worktree: "",
      allowedWorktreeRoots: [worktreeParent],
    },
  );

  assert.equal(resolved, worktree);

  assert.equal(existsSync(path.join(worktree, ".git")), true);
  assert.equal(
    await prepareWorktree({
      repoCwd: repo,
      message: "Implement task",
      cwd: worktree,
      worktree: "",
      allowedWorktreeRoots: [worktreeParent],
    }),
    worktree,
  );
  await assert.rejects(
    () =>
      prepareWorktree({
        repoCwd: repo,
        message: "Invalid branch",
        cwd: path.join(worktreeParent, "invalid-branch"),
        worktree: "invalid branch name",
        allowedWorktreeRoots: [worktreeParent],
      }),
    /Invalid Git branch name/,
  );

  const defaultWorktree = await prepareWorktree({
    repoCwd: repo,
    message: "Add Default Folder",
    worktree: "",
  });

  assert.equal(defaultWorktree.startsWith(path.join(repo, ".agentfiles", "worktrees")), true);

  assert.equal(existsSync(path.join(defaultWorktree, ".git")), true);
  await runtime.dispose();
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

  assert.equal(resolved.startsWith(path.join(repo, ".agentfiles", "worktrees")), true);

  assert.equal(existsSync(path.join(resolved, ".git")), true);
});

test("automatic worktree requests can identify the source repository through cwd", async () => {
  const caller = mkdtempSync(path.join(tmpdir(), "pi-gentic-caller-"));
  const repo = createGitRepo();
  const runtime = createExtensionRuntime();
  const orchestrator = new PiGenticOrchestrator({}, runtime);

  try {
    const resolved = await orchestrator.resolveSendCwd(
      { cwd: caller },
      { message: "Implement task", cwd: repo, worktree: true },
    );

    assert.equal(resolved.startsWith(path.join(repo, ".agentfiles", "worktrees")), true);
    assert.equal(existsSync(path.join(resolved, ".git")), true);
  } finally {
    await runtime.dispose();
  }
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

test("worktree preparation reports unavailable Git executables", async () => {
  const repo = createGitRepo();
  const originalPath = process.env.PATH;

  try {
    process.env.PATH = "";
    await assert.rejects(
      () => prepareWorktree({ repoCwd: repo, message: "Missing Git" }),
      /Worktree repository must be a git repository/,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("send confirmation tells callers not to wait or duplicate delegated work", () => {
  const text = sendConfirmationText("researcher", "019ecdce-4317-701b-9c51-1b05272f0db0", "check that");

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
  assert.equal(abortActor({ sessionManager: { getEntries: () => [] } }), "caller session");

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

  const staleContext = {};
  Object.defineProperty(staleContext, "sessionManager", {
    get() {
      throw new Error(staleContextError);
    },
  });
  assert.equal(abortActor(staleContext), "caller session");
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

test("session outcomes explain model errors and missing responses", () => {
  const runtime = (messages) => ({
    agentName: "reviewer",
    session: {
      sessionManager: { getSessionId: () => "error-session" },
      agent: { state: { messages } },
    },
  });

  const modelError = sessionRunOutcome(
    runtime([
      {
        role: "assistant",
        content: "",
        stopReason: "error",
        errorMessage: "Provider unavailable",
      },
    ]),
    { request: "Review" },
  );
  assert.equal(modelError.status, "error");
  assert.match(modelError.text, /Provider unavailable/);

  const diagnosticError = sessionRunOutcome(
    runtime([
      {
        role: "assistant",
        content: "",
        stopReason: "error",
        errorMessage: "Codex stream ended after output began and cannot be continued from its incomplete response.",
        diagnostics: [
          {
            type: "provider_stream_failure",
            error: { message: "Your input exceeds the context window of this model." },
          },
        ],
      },
    ]),
    { request: "Research" },
  );
  assert.match(diagnosticError.text, /Your input exceeds the context window of this model\./);
  assert.doesNotMatch(diagnosticError.text, /cannot be continued/);

  const thrown = sessionRunOutcome(runtime([]), {
    request: "Review",
    error: new Error("Connection lost"),
  });
  assert.equal(thrown.status, "error");
  assert.match(thrown.text, /Connection lost/);

  const missing = sessionRunOutcome(runtime([]), { request: "Review" });
  assert.equal(missing.status, "stopped");
  assert.match(missing.text, /No assistant response/);

  const customStop = sessionRunOutcome(runtime([{ role: "assistant", content: "", stopReason: "tool_use" }]), {
    request: "Review",
  });
  assert.equal(customStop.status, "stopped");
  assert.match(customStop.text, /tool_use/);
});

test("activity monitors reset inactivity for lifecycle and reasoning progress", () => {
  const originalNow = Date.now;
  const published = [];

  try {
    Date.now = () => 1_000;
    const monitor = createSessionActivityMonitor({ status: "running", updatedAt: 100 }, (details) => {
      published.push(details);
      return details;
    });

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

test("activity monitors assemble Pi 0.84 JSON and RPC assistant deltas", () => {
  const published = [];
  const monitor = createSessionActivityMonitor({ status: "running" }, (details) => {
    published.push(details);
    return details;
  });

  monitor.observe({
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  monitor.observe({
    type: "message_update",
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
  });
  monitor.observe({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working" },
  });
  monitor.observe({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " now" },
  });

  assert.equal(published.at(-1).activities.at(-1).text, "Working now");

  monitor.observe({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Work complete" },
  });

  assert.equal(published.at(-1).activities.at(-1).text, "Work complete");
});

test("activity monitors normalize every native progress event", () => {
  const published = [];
  const monitor = createSessionActivityMonitor({ status: "running" }, (details) => {
    published.push(details);
    return details;
  });
  const events = [
    {
      type: "tool_execution_start",
      toolCallId: "tool",
      toolName: "read",
      args: { path: "one" },
    },
    {
      type: "tool_execution_update",
      toolCallId: "tool",
      toolName: "read",
      partialResult: [{ text: "two" }],
    },
    {
      type: "tool_execution_end",
      toolCallId: "tool",
      toolName: "read",
      result: { content: [{ text: "three" }] },
      isError: true,
    },
    {
      type: "message_update",
      message: { role: "assistant", content: "Working" },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    },
  ];

  for (const event of events) monitor.observe(event);
  assert.deepEqual(
    published.at(-1).activities.map((activity) => activity.id),
    ["tool", "assistant"],
  );
  assert.equal(published.at(-1).activities[0].status, "error");
  assert.equal(monitor.fail("failure").status, "error");
  assert.equal(monitor.stop("aborted").status, "aborted");

  assert.deepEqual(
    collectSessionActivities({
      agent: {
        state: {
          messages: [
            { role: "assistant", content: "", stopReason: "aborted" },
            {
              role: "assistant",
              content: "",
              stopReason: "error",
              errorMessage: "Model failed",
            },
            {
              role: "toolResult",
              toolCallId: "result",
              toolName: "write",
              content: [{ text: "saved" }],
              isError: false,
            },
          ],
        },
      },
    }).map(({ type, status }) => ({ type, status })),
    [
      { type: "assistant", status: "aborted" },
      { type: "assistant", status: "error" },
      { type: "tool", status: "done" },
    ],
  );
});

test("activity projection bounds cyclic content and stays responsive through 20,000 events", () => {
  let latest;
  const monitor = createSessionActivityMonitor({ status: "running" }, (details) => (latest = details));
  const result = { payload: "x".repeat(1_000_000) };
  result.self = result;

  assert.doesNotThrow(() =>
    monitor.observe({ type: "tool_execution_update", toolCallId: "large-tool", partialResult: result }),
  );
  monitor.observe({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "y".repeat(1_000_000) }] },
  });
  assert.ok(latest.activities.find(({ id }) => id === "large-tool").summary.length <= 240);
  assert.ok(latest.activities.find(({ id }) => id === "assistant").text.length <= 240);
  assert.ok(JSON.stringify(latest).length < 2_000);

  const startedAt = performance.now();

  for (let index = 0; index < 20_000; index++)
    monitor.observe({
      type: "tool_execution_end",
      toolCallId: `stress-${index}`,
      toolName: "edit",
      result: { content: [{ text: "done" }] },
      isError: false,
    });

  const durationMs = performance.now() - startedAt;
  assert.equal(latest.activityCount, 20_002);
  assert.equal(latest.activities.length, 100);
  assert.equal(latest.activities[0].id, "stress-19900");
  assert.equal(latest.activities.at(-1).id, "stress-19999");
  assert.ok(JSON.stringify(latest).length < 30_000);
  assert.ok(durationMs < 500, `Expected 20,000 activities under 500ms, took ${durationMs.toFixed(1)}ms.`);
});

test("activity monitors preserve the completed answer in terminal card state", () => {
  const published = [];
  const monitor = createSessionActivityMonitor({ status: "running", updatedAt: 100 }, (details) => {
    published.push(details);
    return details;
  });

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
  const monitor = createSessionActivityMonitor({ status: "queued", updatedAt: 100 }, (details) => {
    published.push(details);
    return details;
  });

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
  assert.equal(shouldDeferSendCompletion({ async: true, awaitCompletion: true }), true);

  assert.equal(shouldDeferSendCompletion({ async: false, awaitCompletion: false }), true);

  assert.equal(shouldDeferSendCompletion({ async: false, awaitCompletion: undefined }), false);
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

  assert.throws(() => assertAvailableAgent("reviewer", agents), /Unavailable agent/);
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
        provider === selectedModel.provider && id === selectedModel.id ? selectedModel : undefined,
      getModels: () => [selectedModel],
      getAvailableSnapshot: () => [selectedModel],
    },
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    sessionManager: {
      appendCustomEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
      getEntries: () => entries,
      getSessionId: () => sessionId,
    },
    getAllTools: () => [],
    getActiveToolNames: () => [],
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
  const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [] }, effectRuntime);

  try {
    await orchestrator.loadAgentIntoSession(session, "researcher", undefined, config);

    assert.deepEqual(appliedModels, [selectedModel]);
    assert.deepEqual(entries.at(-1)?.data, {
      agentName: "researcher",
      overrides: undefined,
    });
  } finally {
    deleteRuntimeSession(sessionId);
  }
});
