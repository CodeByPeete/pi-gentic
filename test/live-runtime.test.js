import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  activeVisibleContext,
  deleteRuntimeSession,
  getLiveRuntimeState,
  getRuntimeSession,
  installLiveSessionBridge,
  parkCurrentLiveRuntimeForSwitch,
  renderVisibleLiveSessionState,
  setRuntimeSession,
  shouldPromptVisibleSessionNow,
  shouldRunVisibleExtensionCommandNow,
  trackSessionPrompt,
} from "../dist/pi-host.js";

test("live runtime state is shared across duplicate module instances", async () => {
  const first = await import(`../dist/pi-host.js?instance=${Date.now()}-a`);
  const second = await import(`../dist/pi-host.js?instance=${Date.now()}-b`);

  assert.equal(first.getLiveRuntimeState(), second.getLiveRuntimeState());

  const runtime = { session: { isStreaming: false } };
  first.setRuntimeSession("duplicate-runtime", runtime);
  assert.equal(second.getRuntimeSession("duplicate-runtime"), runtime);
  second.deleteRuntimeSession("duplicate-runtime");

  let aborted = false;
  const call = first.registerAgentCall({
    callerSessionId: "duplicate-caller",
    abort: () => {
      aborted = true;
    },
  });
  try {
    assert.equal(second.hasAgentCallsForSession("duplicate-caller"), true);
    await second.abortAgentCallsForSession("duplicate-caller");
    assert.equal(aborted, true);
  } finally {
    call.unregister();
  }
});

test("runtime registry preserves object identity for live activity updates", () => {
  const runtime = {
    createdAt: "2026-01-01T00:00:00.000Z",
    session: {
      isStreaming: true,
      sessionManager: { getSessionId: () => "activity-session" },
    },
  };

  const stored = setRuntimeSession("activity-session", runtime);
  runtime.lastActivityAt = "2026-01-01T00:00:10.000Z";

  assert.equal(stored, runtime);

  assert.equal(
    getRuntimeSession("activity-session").lastActivityAt,
    "2026-01-01T00:00:10.000Z",
  );
});

test("active visible context is shared through live runtime state", () => {
  const state = getLiveRuntimeState();
  const previous = state.activeContext;
  const ctx = { sessionManager: { getSessionId: () => "visible-session" } };

  state.activeContext = ctx;

  assert.equal(activeVisibleContext(), ctx);

  state.activeContext = previous;
});

test("normal visible prompts are tracked while they are running", async () => {
  const session = {
    isStreaming: false,
    sessionManager: {
      getEntries: () => [],
      getHeader: () => ({ parentSession: "parent.jsonl" }),
      getSessionId: () => "visible-prompt-session",
    },
  };

  await trackSessionPrompt(
    session,
    async () => {
      session.isStreaming = true;
      const runtime = getRuntimeSession("visible-prompt-session");

      assert.equal(runtime.session, session);

      assert.equal(runtime.session.isStreaming, true);

      assert.equal(runtime.parentSessionPath, "parent.jsonl");

      assert.equal(runtime.lastMessage, "Normal prompt");

      session.isStreaming = false;
    },
    "Normal prompt",
  );

  assert.equal(
    getRuntimeSession("visible-prompt-session").session.isStreaming,
    false,
  );

  deleteRuntimeSession("visible-prompt-session");
});

test("visible prompts bypass a blocked input loop after switching sessions", () => {
  const runtime = {
    session: {
      isStreaming: true,
      sessionManager: { getSessionId: () => "background-session" },
    },
  };

  setRuntimeSession("background-session", runtime);

  try {
    assert.equal(
      shouldPromptVisibleSessionNow(
        {
          onInputCallback: undefined,
          session: {
            isStreaming: false,
            sessionManager: { getSessionId: () => "visible-session" },
          },
        },
        "message for the visible session",
      ),
      true,
    );

    assert.equal(
      shouldPromptVisibleSessionNow(
        {
          onInputCallback: () => {},
          session: {
            isStreaming: false,
            sessionManager: { getSessionId: () => "visible-session" },
          },
        },
        "normal loop owns this message",
      ),
      false,
    );

    assert.equal(
      shouldPromptVisibleSessionNow(
        {
          onInputCallback: undefined,
          session: {
            isStreaming: true,
            sessionManager: { getSessionId: () => "visible-session" },
          },
        },
        "visible streaming uses native queueing",
      ),
      false,
    );
  } finally {
    deleteRuntimeSession("background-session");
  }
});

test("submit bridge prompts the visible session when another session blocks input", async () => {
  const state = getLiveRuntimeState();

  await installBridgeForTest(state, "submitBridgeInstalled");
  const { InteractiveMode } = await import(
    pathToFileURL(
      path.resolve(
        "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js",
      ),
    ).href
  );
  const prompts = [];
  const history = [];
  const runtime = {
    session: {
      isStreaming: true,
      sessionManager: { getSessionId: () => "blocked-session" },
    },
  };
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    defaultEditor: {},
    editor: {
      text: "message for opened session",
      addToHistory: (text) => history.push(text),
      getText() {
        return this.text;
      },
      setText(text) {
        this.text = text;
      },
    },
    flushPendingBashComponents() {},
    onInputCallback: undefined,
    ui: { requestRender() {} },
    updatePendingMessagesDisplay() {},
  });

  Object.defineProperty(mode, "session", {
    value: {
      isStreaming: false,
      prompt: async (text) => prompts.push(text),
      sessionManager: { getSessionId: () => "opened-session" },
    },
  });

  setRuntimeSession("blocked-session", runtime);

  try {
    mode.setupEditorSubmitHandler();

    await mode.defaultEditor.onSubmit("message for opened session");

    assert.deepEqual(prompts, ["message for opened session"]);
    assert.deepEqual(history, ["message for opened session"]);
    assert.equal(mode.editor.getText(), "");

    mode.editor.text = "/review opened session";
    await mode.defaultEditor.onSubmit("/review opened session");

    assert.deepEqual(prompts, [
      "message for opened session",
      "/review opened session",
    ]);
    assert.deepEqual(history, [
      "message for opened session",
      "/review opened session",
    ]);
    assert.equal(mode.editor.getText(), "");
  } finally {
    deleteRuntimeSession("blocked-session");
  }
});

test("visible extension commands run while a background session is streaming", () => {
  const runtime = {
    session: {
      isStreaming: true,
      sessionManager: { getSessionId: () => "background-session" },
    },
  };

  setRuntimeSession("background-session", runtime);

  try {
    assert.equal(
      shouldRunVisibleExtensionCommandNow(
        {
          session: {
            isStreaming: false,
            extensionRunner: { getCommand: (name) => name === "agent" },
            sessionManager: { getSessionId: () => "visible-session" },
          },
        },
        "/agent",
      ),
      true,
    );

    assert.equal(
      shouldRunVisibleExtensionCommandNow(
        {
          session: {
            isStreaming: false,
            extensionRunner: { getCommand: () => undefined },
            sessionManager: { getSessionId: () => "visible-session" },
          },
        },
        "/unknown",
      ),
      false,
    );
  } finally {
    deleteRuntimeSession("background-session");
  }
});

test("live visible session state hydrates unpersisted assistant activity immediately", () => {
  const user = { role: "user", content: "work now" };
  const assistant = {
    role: "assistant",
    content: [
      { type: "text", text: "working" },
      {
        type: "toolCall",
        id: "tool-call-1",
        name: "agents",
        arguments: { action: "send" },
      },
    ],
  };
  const events = [];
  const mode = liveHydrationMode({
    persistedMessages: [user],
    liveMessages: [user, assistant],
    events,
  });

  assert.equal(renderVisibleLiveSessionState(mode), true);

  assert.deepEqual(
    mode.renderedContexts.map((context) => context.messages),
    [[user]],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["message_start", "message_update", "tool_execution_start"],
  );
  assert.equal(events[0].message, assistant);
  assert.equal(events[2].toolName, "agents");
});

test("live visible session hydration attaches the current streaming message before later updates", () => {
  const user = { role: "user", content: "stream continuously" };
  const initialStreamingMessage = {
    role: "assistant",
    content: [{ type: "text", text: "line 1" }],
  };
  const events = [];
  const mode = liveHydrationMode({
    persistedMessages: [user],
    liveMessages: [user],
    streamingMessage: initialStreamingMessage,
    events,
  });

  assert.equal(renderVisibleLiveSessionState(mode), true);
  assert.deepEqual(
    events.map((event) => event.type),
    ["message_start", "message_update"],
  );
  assert.equal(events[0].message, initialStreamingMessage);

  for (let line = 2; line <= 100; line++) {
    mode.handleEvent({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `line ${line}` }],
      },
    });
  }

  mode.handleEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "line 100" }],
      stopReason: "stop",
    },
  });

  assert.equal(events.length, 102);
  assert.equal(events.at(-2).message.content[0].text, "line 100");
  assert.equal(events.at(-1).type, "message_end");
});

test("current InteractiveMode hydrates an active streaming message after its native session render", async () => {
  const state = getLiveRuntimeState();

  await installBridgeForTest(state, "liveHydrationBridgeInstalled");
  const { InteractiveMode } = await import(
    pathToFileURL(
      path.resolve(
        "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js",
      ),
    ).href
  );
  const streamingMessage = {
    role: "assistant",
    content: [{ type: "text", text: "already streaming" }],
  };
  const events = [];
  let nativeRenders = 0;
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    loadedResourcesContainer: { clear() {} },
    chatContainer: { clear() {} },
    pendingMessagesContainer: { clear() {} },
    pendingTools: new Map(),
    runtimeHost: {
      session: {
        isStreaming: true,
        state: { messages: [], streamingMessage },
      },
    },
    renderInitialMessages() {
      nativeRenders += 1;
    },
    handleEvent(event) {
      events.push(event);
    },
  });

  mode.renderCurrentSessionState();

  assert.equal(nativeRenders, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ["message_start", "message_update"],
  );
  assert.equal(events[0].message, streamingMessage);
});

test("live visible session hydration preserves persisted orchestration cards while replaying new assistant text", () => {
  const user = { role: "user", content: "delegate while active" };
  const card = {
    role: "custom",
    customType: "pi-gentic:card",
    content: "Sending message to researcher...",
    display: true,
    details: { kind: "send", status: "running", sessionId: "child-session" },
  };
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "I am still generating after resume." }],
  };
  const events = [];
  const mode = liveHydrationMode({
    persistedMessages: [user, card],
    liveMessages: [user, assistant],
    events,
  });

  assert.equal(renderVisibleLiveSessionState(mode), true);

  assert.deepEqual(
    mode.renderedContexts.map((context) => context.messages),
    [[user, card]],
  );
  assert.deepEqual(events.map((event) => event.type), [
    "message_start",
    "message_update",
  ]);
  assert.equal(events[0].message, assistant);
});

test("live visible session hydration skips stale persisted regular messages and keeps current custom UI", () => {
  const user = { role: "user", content: "continue" };
  const staleAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "old partial text" }],
  };
  const card = {
    role: "custom",
    customType: "pi-gentic:card",
    content: "Queued message for builder.",
    display: true,
    details: { kind: "send", status: "queued", sessionId: "child" },
  };
  const liveAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "new live text" }],
  };
  const events = [];
  const mode = liveHydrationMode({
    persistedMessages: [user, staleAssistant, card],
    liveMessages: [user, liveAssistant],
    events,
  });

  assert.equal(renderVisibleLiveSessionState(mode), true);

  assert.deepEqual(
    mode.renderedContexts.map((context) => context.messages),
    [[user, card]],
  );
  assert.deepEqual(events.map((event) => event.message), [
    liveAssistant,
    liveAssistant,
  ]);
});

test("live visible session hydration survives 100 complex persisted and live workflow shapes", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const workflow = complexHydrationWorkflow(seed);
    const events = [];
    const mode = liveHydrationMode({
      persistedMessages: workflow.persistedMessages,
      liveMessages: workflow.liveMessages,
      events,
    });

    assert.equal(renderVisibleLiveSessionState(mode), true, `seed ${seed}`);

    const renderedMessages = mode.renderedContexts.at(-1).messages;
    for (const message of workflow.persistedCustomMessages)
      assert.ok(
        renderedMessages.includes(message),
        `seed ${seed} lost custom message ${message.content}`,
      );

    for (const message of workflow.staleMessages)
      assert.ok(
        !renderedMessages.includes(message),
        `seed ${seed} rendered stale message`,
      );

    const replayedMessages = events
      .filter((event) => event.type === "message_start")
      .map((event) => event.message);

    assert.deepEqual(
      replayedMessages,
      workflow.expectedReplayMessages,
      `seed ${seed}`,
    );
  }
});

test("live visible session hydration restarts live-only tool calls when message updates are asynchronous", async () => {
  const user = { role: "user", content: "delegate from active parent" };
  const assistant = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "agents-race-call",
        name: "agents",
        arguments: { action: "send", async: false },
      },
    ],
  };
  const events = [];
  const mode = liveHydrationMode({
    persistedMessages: [user],
    liveMessages: [user, assistant],
    events,
  });

  mode.handleEvent = async (event) => {
    events.push(event);
    if (event.type !== "message_update") return;

    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const toolCall of event.message.content?.filter(
      (part) => part.type === "toolCall",
    ) ?? [])
      mode.pendingTools.set(toolCall.id, {});
  };

  assert.equal(renderVisibleLiveSessionState(mode), true);

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(
    events.map((event) => event.type),
    ["message_start", "message_update", "tool_execution_start"],
  );
});

test("live visible session state restarts already-rendered pending tool activity", () => {
  const user = { role: "user", content: "delegate" };
  const assistant = {
    role: "assistant",
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        id: "agents-call",
        name: "agents",
        arguments: { action: "send" },
      },
    ],
  };
  const events = [];
  const mode = liveHydrationMode({
    persistedMessages: [user, assistant],
    liveMessages: [user, assistant],
    events,
  });

  assert.equal(renderVisibleLiveSessionState(mode), true);

  assert.deepEqual(
    mode.renderedContexts.map((context) => context.messages),
    [[user, assistant]],
  );
  assert.deepEqual(events.map((event) => event.type), ["tool_execution_start"]);
  assert.equal(events[0].toolCallId, "agents-call");
});

test("live visible session hydration leaves non-streaming sessions alone", () => {
  const mode = liveHydrationMode({
    persistedMessages: [],
    liveMessages: [{ role: "user", content: "done" }],
    streaming: false,
  });

  assert.equal(renderVisibleLiveSessionState(mode), false);
  assert.deepEqual(mode.renderedContexts, []);
});

test("AgentSession dispose cleans stale pi-gentic runtime references", async () => {
  const state = getLiveRuntimeState();

  state.liveRuntimes.clear();
  await installBridgeForTest(state, "disposeBridgeInstalled");
  const { AgentSession } = await import(
    pathToFileURL(
      path.resolve(
        "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js",
      ),
    ).href
  );
  const session = Object.assign(Object.create(AgentSession.prototype), {
    sessionManager: { getSessionId: () => "disposed-agent-session" },
    abortRetry: () => {},
    abortCompaction: () => {},
    abortBranchSummary: () => {},
    abortBash: () => {},
    agent: { state: { isStreaming: false }, abort: () => {} },
    _extensionRunner: { invalidate: () => {} },
    _disconnectFromAgent: () => {},
    _eventListeners: [],
  });

  state.liveRuntimes.set("disposed-agent-session", { runtime: { session } });
  setRuntimeSession("disposed-agent-session", { session });

  try {
    session.dispose();

    assert.equal(getRuntimeSession("disposed-agent-session"), undefined);
    assert.equal(state.liveRuntimes.has("disposed-agent-session"), false);
  } finally {
    deleteRuntimeSession("disposed-agent-session");
    state.liveRuntimes.clear();
  }
});

test("/new parks the active visible run instead of disposing it", async () => {
  const state = getLiveRuntimeState();
  state.liveRuntimes.clear();
  await installBridgeForTest(state, "newSessionBridgeInstalled");
  const { AgentSessionRuntime } = await import(
    pathToFileURL(
      path.resolve(
        "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js",
      ),
    ).href
  );
  const sessionDir = mkdtempSync(path.join(tmpdir(), "pi-gentic-new-"));
  let disposed = 0;
  const session = {
    isStreaming: true,
    sessionFile: path.join(sessionDir, "running.jsonl"),
    dispose: () => {
      disposed += 1;
    },
    extensionRunner: { hasHandlers: () => false, emit: async () => ({}) },
    sessionManager: {
      getHeader: () => ({}),
      getSessionDir: () => sessionDir,
      getSessionId: () => "new-running-session",
      isPersisted: () => true,
    },
  };
  const runtimeHost = new AgentSessionRuntime(
    session,
    { cwd: process.cwd(), agentDir: process.cwd() },
    async ({ sessionManager }) => ({
      diagnostics: [],
      services: { cwd: process.cwd(), agentDir: process.cwd() },
      session: {
        agent: { state: { messages: [] } },
        createReplacedSessionContext: () => ({}),
        dispose: () => {},
        extensionRunner: { hasHandlers: () => false, emit: async () => ({}) },
        isStreaming: false,
        sessionFile: sessionManager.getSessionFile(),
        sessionManager: {
          buildSessionContext: () => ({ messages: [] }),
          getHeader: () => ({}),
          getSessionId: () => "new-created-session",
        },
      },
    }),
  );

  setRuntimeSession("new-running-session", { runtimeHost, session });

  try {
    await runtimeHost.newSession();

    assert.equal(disposed, 0);
    assert.equal(
      state.liveRuntimes.get("new-running-session").runtime,
      runtimeHost,
    );
  } finally {
    deleteRuntimeSession("new-running-session");
    state.liveRuntimes.clear();
  }
});

test("switching away from an opened live run parks it instead of disposing it", () => {
  const state = getLiveRuntimeState();
  state.liveRuntimes.clear();
  let disposed = 0;
  const session = {
    isStreaming: true,
    dispose: () => {
      disposed += 1;
    },
    sessionManager: { getSessionId: () => "running-session" },
  };
  const runtimeHost = { session };

  setRuntimeSession("running-session", { runtimeHost, session });
  const restore = parkCurrentLiveRuntimeForSwitch(state, runtimeHost);

  session.dispose();

  assert.equal(disposed, 0);

  assert.equal(state.liveRuntimes.get("running-session").runtime, runtimeHost);

  restore();
  session.dispose();

  assert.equal(disposed, 1);
});

test("switching away from an unregistered visible run parks it instead of disposing it", () => {
  const state = getLiveRuntimeState();
  state.liveRuntimes.clear();
  let disposed = 0;
  const session = {
    isStreaming: true,
    dispose: () => {
      disposed += 1;
    },
    sessionManager: { getSessionId: () => "visible-running-session" },
  };
  const runtimeHost = { session };
  const restore = parkCurrentLiveRuntimeForSwitch(state, runtimeHost);

  session.dispose();

  assert.equal(disposed, 0);

  assert.equal(
    state.liveRuntimes.get("visible-running-session").runtime.session,
    session,
  );

  runtimeHost.session = {
    sessionManager: { getSessionId: () => "next-session" },
  };

  assert.equal(
    state.liveRuntimes.get("visible-running-session").runtime.session,
    session,
  );

  restore();
  session.dispose();

  assert.equal(disposed, 1);
});

function complexHydrationWorkflow(seed) {
  const user = {
    role: "user",
    content: [{ type: "text", text: `workflow ${seed}` }],
  };
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: `live answer ${seed}` }],
  };
  const toolAssistant = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `tool-${seed}`,
        name: "agents",
        arguments: { action: "send", seed },
      },
    ],
  };
  const toolResult = {
    role: "toolResult",
    toolCallId: `tool-${seed}`,
    toolName: "agents",
    content: `tool result ${seed}`,
  };
  const staleMessages = [];
  const persistedCustomMessages = Array.from(
    { length: 1 + (seed % 4) },
    (_, index) => ({
      role: "custom",
      customType: "pi-gentic:card",
      content: `card ${seed}.${index}`,
      display: true,
      details: {
        kind: "send",
        status: index % 2 === 0 ? "running" : "queued",
        sessionId: `child-${seed}-${index}`,
      },
    }),
  );
  const liveMessages =
    seed % 3 === 0
      ? [user, toolAssistant, toolResult, assistant]
      : seed % 3 === 1
        ? [user, assistant]
        : [user, toolAssistant];
  const persistedMessages = [user];

  if (seed % 5 === 0) {
    const stale = {
      role: "assistant",
      content: [{ type: "text", text: `stale ${seed}` }],
    };

    persistedMessages.push(stale);
    staleMessages.push(stale);
  }

  persistedMessages.push(...persistedCustomMessages.slice(0, seed % 4));

  if (seed % 2 === 0 && liveMessages.includes(toolAssistant))
    persistedMessages.push(toolAssistant);

  persistedMessages.push(...persistedCustomMessages.slice(seed % 4));

  if (seed % 7 === 0) {
    const staleTool = {
      role: "toolResult",
      toolCallId: `stale-tool-${seed}`,
      toolName: "agents",
      content: `stale tool ${seed}`,
    };

    persistedMessages.push(staleTool);
    staleMessages.push(staleTool);
  }

  let matchedLiveCount = 0;
  for (const message of persistedMessages) {
    if (message.role === "custom") continue;
    if (message === liveMessages[matchedLiveCount]) matchedLiveCount += 1;
  }

  return {
    expectedReplayMessages: liveMessages.slice(matchedLiveCount),
    liveMessages,
    persistedCustomMessages,
    persistedMessages,
    staleMessages,
  };
}

function liveHydrationMode({
  persistedMessages,
  liveMessages,
  streamingMessage,
  events = [],
  streaming = true,
}) {
  const agentState = {
    messages: liveMessages,
    ...(streamingMessage ? { streamingMessage } : {}),
  };

  return {
    renderedContexts: [],
    chatContainer: { clear() {} },
    pendingMessagesContainer: { clear() {} },
    pendingTools: new Map(
      liveMessages
        .flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter((part) => part.type === "toolCall")
            : [],
        )
        .map((toolCall) => [toolCall.id, {}]),
    ),
    session: {
      isStreaming: streaming,
      state: agentState,
      agent: { state: agentState },
      sessionManager: {
        buildSessionContext: () => ({ messages: persistedMessages }),
      },
    },
    renderSessionContext(context) {
      this.renderedContexts.push(context);
      for (const message of context.messages) {
        if (!Array.isArray(message.content)) continue;
        for (const toolCall of message.content.filter(
          (part) => part.type === "toolCall",
        ))
          this.pendingTools.set(toolCall.id, {});
      }
    },
    handleEvent(event) {
      events.push(event);
      if (event.type === "message_update") {
        for (const toolCall of event.message.content?.filter(
          (part) => part.type === "toolCall",
        ) ?? [])
          this.pendingTools.set(toolCall.id, {});
      }
    },
  };
}

async function installBridgeForTest(state, flag) {
  process.env.PI_CLI = path.resolve(
    "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  );
  await installLiveSessionBridge();

  assert.equal(state[flag], true);
}
