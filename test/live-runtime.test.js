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
  shouldRunVisibleExtensionCommandNow,
  trackSessionPrompt,
} from "../dist/pi-host.js";

test("live runtime state is shared across duplicate module instances", async () => {
  const first = await import(`../dist/pi-host.js?instance=${Date.now()}-a`);
  const second = await import(`../dist/pi-host.js?instance=${Date.now()}-b`);

  assert.equal(first.getLiveRuntimeState(), second.getLiveRuntimeState());
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
            extensionRunner: { getCommand: (name) => name === "orchestration-tree" },
            sessionManager: { getSessionId: () => "visible-session" },
          },
        },
        "/orchestration-tree",
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

function liveHydrationMode({
  persistedMessages,
  liveMessages,
  events = [],
  streaming = true,
}) {
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
      agent: { state: { messages: liveMessages } },
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
  installLiveSessionBridge();

  for (let attempt = 0; attempt < 20; attempt++) {
    if (state[flag]) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(state[flag], true);
}
