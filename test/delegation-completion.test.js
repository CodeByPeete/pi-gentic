import assert from "node:assert/strict";
import test from "node:test";
import { PiGenticOrchestrator } from "../dist/application/delegation/orchestrator.js";
import { deleteRuntimeSession } from "../dist/infrastructure/pi/host.js";
import { createExtensionRuntime } from "../dist/runtime/ExtensionRuntime.js";
import { clearLiveCardDetails } from "./support/cards.js";

const effectRuntime = createExtensionRuntime();
test.after(() => effectRuntime.dispose());

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

function testOrchestrator(runtime, resolveTargetSession) {
  const orchestrator = new PiGenticOrchestrator({ getAllTools: () => [], sendMessage: () => {} }, runtime);

  orchestrator.load = () => ({});
  orchestrator.resolvePolicy = () => ({ agentsTool: {} });
  orchestrator.resolveTargetSession = resolveTargetSession;
  return orchestrator;
}

function agentTarget({ agentName, sessionId, messages, prompt }) {
  return {
    agentName,
    session: {
      agent: { state: { messages } },
      isStreaming: false,
      sessionManager: {
        appendCustomMessageEntry() {},
        getSessionId: () => sessionId,
      },
      prompt,
      abort: async () => {},
    },
  };
}

test("send returns an agent's resumed answer after joined work settles in another runtime", async () => {
  const callerSessionId = "hierarchical-caller";
  const agentSessionId = "hierarchical-agent";
  const descendantSessionId = "hierarchical-descendant";
  const agentMessages = [];
  const descendantMessages = [];
  const descendantFinished = Promise.withResolvers();
  const descendantSettled = Promise.withResolvers();
  const agentRuntime = createExtensionRuntime();
  let agentPromptCount = 0;
  let agentOrchestrator;
  const agent = agentTarget({
    agentName: "generic-agent",
    sessionId: agentSessionId,
    messages: agentMessages,
    prompt: async () => {
      agentPromptCount += 1;
      if (agentPromptCount === 1) {
        await agentOrchestrator.send(
          callerContext(agentSessionId),
          { message: "Complete the joined work", async: true, invokeMeLater: true },
          { onSettled: descendantSettled.resolve },
        );
        agentMessages.push({ role: "assistant", content: "Waiting for joined work", stopReason: "stop" });
        return;
      }
      agentMessages.push({ role: "assistant", content: "Independent answer", stopReason: "stop" });
    },
  });
  const descendant = agentTarget({
    agentName: "generic-descendant",
    sessionId: descendantSessionId,
    messages: descendantMessages,
    prompt: async () => {
      await descendantFinished.promise;
      descendantMessages.push({ role: "assistant", content: "Joined answer", stopReason: "stop" });
    },
  });
  const rootOrchestrator = testOrchestrator(effectRuntime, async () => agent);
  agentOrchestrator = testOrchestrator(agentRuntime, async () => descendant);
  agentOrchestrator.deliverCallerCard = async (_ctx, delivery) => {
    agentMessages.push({
      role: "assistant",
      content: `Final answer informed by ${delivery.text}`,
      stopReason: "stop",
    });
    return "background";
  };
  const resultPromise = rootOrchestrator.send(callerContext(callerSessionId), {
    message: "Coordinate joined work",
    async: false,
  });
  let returned = false;
  void resultPromise.then(() => {
    returned = true;
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(returned, false);
    const agentDisposal = agentRuntime.disposeWhenIdle();

    const independentResultPromise = rootOrchestrator.send(callerContext("independent-caller"), {
      message: "Complete independent work",
      async: false,
    });
    let independentReturned = false;
    void independentResultPromise.then(() => {
      independentReturned = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(independentReturned, true);
    assert.match((await independentResultPromise).text, /Independent answer/);

    descendantFinished.resolve();
    const result = await resultPromise;
    await descendantSettled.promise;
    await agentDisposal;

    assert.match(result.text, /Final answer informed by.*Joined answer/s);
  } finally {
    descendantFinished.resolve();
    await agentRuntime.dispose();
    deleteRuntimeSession(agentSessionId);
    deleteRuntimeSession(descendantSessionId);
  }
});

test("joined completion composes through arbitrary agent depth", async () => {
  const rootRuntime = createExtensionRuntime();
  const middleRuntime = createExtensionRuntime();
  const descendantRuntime = createExtensionRuntime();
  const middleMessages = [];
  const descendantMessages = [];
  const leafMessages = [];
  const firstLeafFinished = Promise.withResolvers();
  const secondLeafFinished = Promise.withResolvers();
  let leafPromptCount = 0;
  let leafDeliveryCount = 0;
  const middleSessionId = "deep-middle";
  const descendantSessionId = "deep-descendant";
  const leafSessionId = "deep-leaf";
  let middleOrchestrator;
  let descendantOrchestrator;
  const middle = agentTarget({
    agentName: "generic-middle",
    sessionId: middleSessionId,
    messages: middleMessages,
    prompt: async () => {
      await middleOrchestrator.send(callerContext(middleSessionId), {
        message: "Delegate one level deeper",
        async: true,
        invokeMeLater: true,
      });
      middleMessages.push({ role: "assistant", content: "Waiting for descendant", stopReason: "stop" });
    },
  });
  const descendant = agentTarget({
    agentName: "generic-descendant",
    sessionId: descendantSessionId,
    messages: descendantMessages,
    prompt: async () => {
      await descendantOrchestrator.send(callerContext(descendantSessionId), {
        message: "Complete leaf work",
        async: true,
        invokeMeLater: true,
      });
      descendantMessages.push({ role: "assistant", content: "Waiting for leaf", stopReason: "stop" });
    },
  });
  const leaf = agentTarget({
    agentName: "generic-leaf",
    sessionId: leafSessionId,
    messages: leafMessages,
    prompt: async () => {
      leafPromptCount += 1;
      await (leafPromptCount === 1 ? firstLeafFinished.promise : secondLeafFinished.promise);
      leafMessages.push({
        role: "assistant",
        content: leafPromptCount === 1 ? "First deep answer" : "Second deep answer",
        stopReason: "stop",
      });
    },
  });
  const rootOrchestrator = testOrchestrator(rootRuntime, async () => middle);
  middleOrchestrator = testOrchestrator(middleRuntime, async () => descendant);
  descendantOrchestrator = testOrchestrator(descendantRuntime, async () => leaf);
  descendantOrchestrator.deliverCallerCard = async (_ctx, delivery) => {
    leafDeliveryCount += 1;
    if (leafDeliveryCount === 1) {
      await descendantOrchestrator.send(callerContext(descendantSessionId), {
        message: "Complete late leaf work",
        async: true,
        invokeMeLater: true,
      });
      descendantMessages.push({ role: "assistant", content: "Waiting for late leaf", stopReason: "stop" });
      return "background";
    }
    descendantMessages.push({
      role: "assistant",
      content: `Descendant final from ${delivery.text}`,
      stopReason: "stop",
    });
    return "background";
  };
  middleOrchestrator.deliverCallerCard = async (_ctx, delivery) => {
    middleMessages.push({
      role: "assistant",
      content: `Middle final from ${delivery.text}`,
      stopReason: "stop",
    });
    return "background";
  };
  const resultPromise = rootOrchestrator.send(callerContext("deep-root"), {
    message: "Coordinate deep work",
    async: false,
  });
  let returned = false;
  void resultPromise.then(() => {
    returned = true;
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(returned, false);
    firstLeafFinished.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(returned, false);
    secondLeafFinished.resolve();
    assert.match((await resultPromise).text, /Middle final.*Descendant final.*Second deep answer/s);
  } finally {
    firstLeafFinished.resolve();
    secondLeafFinished.resolve();
    await Promise.all([rootRuntime.dispose(), middleRuntime.dispose(), descendantRuntime.dispose()]);
    deleteRuntimeSession(middleSessionId);
    deleteRuntimeSession(descendantSessionId);
    deleteRuntimeSession(leafSessionId);
  }
});

test("delegations created in the same clock tick keep distinct identities", async () => {
  const originalNow = Date.now;
  const runtime = createExtensionRuntime();
  const targetSessionId = "same-tick-target";
  const target = agentTarget({
    agentName: "generic-agent",
    sessionId: targetSessionId,
    messages: [],
    prompt: async () => {},
  });
  const orchestrator = testOrchestrator(runtime, async () => target);

  try {
    Date.now = () => 1_000;
    const firstSettled = Promise.withResolvers();
    const secondSettled = Promise.withResolvers();
    const [first, second] = await Promise.all([
      orchestrator.send(
        callerContext("same-tick-caller"),
        { message: "First", async: true },
        { onSettled: firstSettled.resolve },
      ),
      orchestrator.send(
        callerContext("same-tick-caller"),
        { message: "Second", async: true },
        { onSettled: secondSettled.resolve },
      ),
    ]);

    assert.notEqual(first.details.cardId, second.details.cardId);
    await Promise.all([firstSettled.promise, secondSettled.promise]);
  } finally {
    Date.now = originalNow;
    await runtime.dispose();
    deleteRuntimeSession(targetSessionId);
  }
});

test("follow-up sends sharing one target run deliver one completion per caller", async () => {
  const callerSessionId = "shared-run-caller";
  const otherCallerSessionId = "other-shared-run-caller";
  const targetSessionId = "shared-run-target";
  const messages = [];
  const queuedPrompts = [];
  const delegationMarkers = [];
  const persistedCards = [];
  const deliveries = [];
  const listeners = new Set();
  let finishTarget;
  let markInitialStarted;
  const targetCanFinish = new Promise((resolve) => {
    finishTarget = resolve;
  });
  const initialStarted = new Promise((resolve) => {
    markInitialStarted = resolve;
  });
  const queueAcceptances = [];
  const session = {
    agent: { state: { messages } },
    isStreaming: false,
    sessionManager: {
      appendCustomMessageEntry: (...args) => delegationMarkers.push(args),
      getSessionId: () => targetSessionId,
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async (text, options) => {
      options?.preflightResult?.(true);
      if (session.isStreaming) {
        queuedPrompts.push(text);
        queueAcceptances.shift()?.();
        return;
      }

      session.isStreaming = true;
      markInitialStarted();
      await targetCanFinish;
      messages.push({ role: "assistant", content: "Shared final answer", stopReason: "stop" });
      session.isStreaming = false;
      for (const listener of listeners) listener({ type: "agent_settled" });
    },
    abort: async () => {},
  };
  const target = { agentName: "builder", session };
  const orchestrator = testOrchestrator(effectRuntime, async () => target);
  orchestrator.deliverCallerCard = async (_ctx, delivery) => {
    deliveries.push(delivery);
    return "live";
  };
  const contextFor = (sessionId) => ({
    cwd: process.cwd(),
    isIdle: () => true,
    sessionManager: {
      appendCustomEntry: (...args) => persistedCards.push([sessionId, ...args]),
      getEntries: () => [],
      getSessionFile: () => `${sessionId}.jsonl`,
      getSessionId: () => sessionId,
    },
  });
  const context = contextFor(callerSessionId);
  const otherContext = contextFor(otherCallerSessionId);
  const pendingCards = [];
  const settlements = [];
  const send = async (caller, message) => {
    let markSettled;
    const settled = new Promise((resolve) => {
      markSettled = resolve;
    });
    settlements.push(settled);
    const pending = await orchestrator.send(caller, { message, async: true }, { onSettled: markSettled });
    pendingCards.push(pending.details);
  };

  try {
    await send(context, "Initial request");
    await initialStarted;

    for (const message of ["First correction", "Second correction", "Final correction"]) {
      const accepted = new Promise((resolve) => queueAcceptances.push(resolve));
      await send(context, message);
      await accepted;
    }
    const otherAccepted = new Promise((resolve) => queueAcceptances.push(resolve));
    await send(otherContext, "Other caller correction");
    await otherAccepted;

    finishTarget();
    await Promise.all(settlements);

    assert.equal(queuedPrompts.length, 4);
    assert.ok(queuedPrompts.every((prompt) => prompt.includes("correction")));
    assert.equal(delegationMarkers.length, 5);
    assert.deepEqual(
      deliveries.map(({ callerSessionId }) => callerSessionId).sort(),
      [callerSessionId, otherCallerSessionId].sort(),
    );
    assert.ok(deliveries.every(({ text }) => text.includes("Shared final answer")));
    assert.deepEqual(
      persistedCards.map(([sessionId]) => sessionId).sort(),
      [callerSessionId, otherCallerSessionId].sort(),
    );
  } finally {
    for (const details of pendingCards) clearLiveCardDetails(details);
    deleteRuntimeSession(targetSessionId);
  }
});
