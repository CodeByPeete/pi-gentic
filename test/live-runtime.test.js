import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  abortAgentCallsForSession,
  activeVisibleContext,
  activeVisibleExtension,
  clearActiveVisibleExtension,
  deleteRuntimeSession,
  getLiveRuntimeState,
  getRuntimeSession,
  installLiveSessionBridge,
  loadPiCodingAgentPeer,
  parkCurrentLiveRuntimeForSwitch,
  registerAgentCall,
  setActiveVisibleExtension,
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

test("live session bridge switches to and cancels native runtime replacements", async () => {
  await installLiveSessionBridge();
  const peer = await loadPiCodingAgentPeer();
  const state = getLiveRuntimeState();
  const target = {
    sessionFile: "target.jsonl",
    sessionManager: { getSessionId: () => "target-live" },
  };
  state.liveRuntimes.set("target-live", {
    runtime: {
      session: target,
      services: { marker: "services" },
      diagnostics: { marker: "diagnostics" },
      modelFallbackMessage: "fallback",
    },
    metadata: {},
  });
  const calls = [];
  const host = {
    emitBeforeSwitch: async () => ({ cancelled: false }),
    teardownCurrent: async (...args) => calls.push(["teardown", ...args]),
    apply: (value) => calls.push(["apply", value]),
    finishSessionReplacement: async (...args) => calls.push(["finish", ...args]),
  };

  try {
    assert.deepEqual(
      await peer.AgentSessionRuntime.prototype.switchSession.call(host, "pi-gentic-live:target-live", {
        withSession: true,
      }),
      { cancelled: false },
    );
    assert.deepEqual(
      calls.map(([name]) => name),
      ["teardown", "apply", "finish"],
    );

    host.emitBeforeSwitch = async () => ({ cancelled: true });
    assert.deepEqual(
      await peer.AgentSessionRuntime.prototype.switchSession.call(host, "pi-gentic-live:target-live", {}),
      { cancelled: true },
    );
    await assert.rejects(
      () => peer.AgentSessionRuntime.prototype.switchSession.call(host, "pi-gentic-live:missing-live", {}),
      /No live pi-gentic session/,
    );

    const originalSwitch = state.hostSwitchSession;
    state.hostSwitchSession = async (_path, options) => {
      await options.withSession?.({ marker: "visible-context" });
      return { cancelled: false, native: true };
    };
    host.session = target;
    assert.deepEqual(
      await peer.AgentSessionRuntime.prototype.switchSession.call(host, "native-session.jsonl", {
        withSession: () => calls.push(["visible"]),
      }),
      { cancelled: false, native: true },
    );
    assert.equal(state.activeContext.marker, "visible-context");
    state.hostSwitchSession = originalSwitch;

    const originalAbort = state.hostAbortSession;
    const originalPrompt = state.hostPromptSession;
    state.hostAbortSession = async () => "native-abort";
    state.hostPromptSession = async () => "native-prompt";
    const bridgedSession = {
      isStreaming: false,
      sessionManager: {
        getEntries: () => [],
        getHeader: () => ({}),
        getSessionId: () => "bridged-session",
      },
    };
    assert.equal(await peer.AgentSession.prototype.abort.call(bridgedSession), "native-abort");
    assert.equal(await peer.AgentSession.prototype.prompt.call(bridgedSession, "bridged prompt"), "native-prompt");
    state.hostAbortSession = originalAbort;
    state.hostPromptSession = originalPrompt;
  } finally {
    state.liveRuntimes.delete("target-live");
  }
});

test("session navigation does not abort work running in any session", async () => {
  await installLiveSessionBridge();
  const peer = await loadPiCodingAgentPeer();
  const state = getLiveRuntimeState();
  const hostAbortSession = state.hostAbortSession;
  let sourceAborts = 0;

  state.hostAbortSession = async () => {
    sourceAborts += 1;
  };

  try {
    for (const sourceIsStreaming of [false, true]) {
      const suffix = sourceIsStreaming ? "streaming" : "idle";
      const sourceSessionId = `navigation-source-${suffix}`;
      const targetSessionId = `navigation-target-${suffix}`;
      let sourceTeardowns = 0;
      let targetAborts = 0;
      const source = {
        isStreaming: sourceIsStreaming,
        abort(...args) {
          return peer.AgentSession.prototype.abort.apply(this, args);
        },
        dispose: () => {},
        sessionManager: { getSessionId: () => sourceSessionId },
      };
      const target = {
        isStreaming: true,
        sessionFile: `${targetSessionId}.jsonl`,
        sessionManager: { getSessionId: () => targetSessionId },
      };
      const call = registerAgentCall({
        id: `navigation-call-${suffix}`,
        callerSessionId: sourceSessionId,
        targetSessionId,
        abort: () => {
          targetAborts += 1;
        },
      });
      const runtimeHost = {
        session: source,
        emitBeforeSwitch: async () => ({ cancelled: false }),
        teardownCurrent: async function () {
          sourceTeardowns += 1;
          await this.session.abort();
          this.session.dispose();
        },
        apply(result) {
          this.session = result.session;
        },
        finishSessionReplacement: async () => {},
      };

      state.liveRuntimes.set(targetSessionId, {
        runtime: { session: target, services: {}, diagnostics: [] },
        metadata: {},
      });

      try {
        assert.deepEqual(
          await peer.AgentSessionRuntime.prototype.switchSession.call(
            runtimeHost,
            `pi-gentic-live:${targetSessionId}`,
            {},
          ),
          { cancelled: false },
        );
        assert.equal(sourceAborts, 0);
        assert.equal(sourceTeardowns, sourceIsStreaming ? 0 : 1);
        assert.equal(targetAborts, 0);
        assert.equal(state.activeCalls.has(call.id), true);
      } finally {
        call.unregister();
        state.liveRuntimes.delete(targetSessionId);
      }
    }
  } finally {
    state.hostAbortSession = hostAbortSession;
  }
});

test("forty-eight concurrent sessions remain responsive through navigation and cancellation", async () => {
  await installLiveSessionBridge();
  const peer = await loadPiCodingAgentPeer();
  const state = getLiveRuntimeState();
  const sessionCount = 48;
  const rootSessionId = "load-root";
  const sessions = [];
  const calls = [];
  const aborted = [];
  let teardowns = 0;
  const startedAt = performance.now();

  for (let index = 0; index < sessionCount; index++) {
    const sessionId = `load-session-${index}`;
    let listener;
    const session = {
      isStreaming: true,
      sessionFile: `${sessionId}.jsonl`,
      abort: async () => {},
      dispose: () => {},
      sessionManager: {
        getHeader: () => ({}),
        getSessionFile: () => `${sessionId}.jsonl`,
        getSessionId: () => sessionId,
      },
      subscribe(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    const runtime = setRuntimeSession(sessionId, { parentSessionId: rootSessionId, session });

    sessions.push({ sessionId, session, runtime, emit: (event) => listener?.(event) });
    state.liveRuntimes.set(sessionId, { runtime: { session, services: {}, diagnostics: [] }, metadata: {} });
    calls.push(
      registerAgentCall({
        id: `load-call-${index}`,
        callerSessionId: rootSessionId,
        targetSessionId: sessionId,
        abort: () => aborted.push(sessionId),
      }),
    );
  }

  const runtimeHost = {
    session: sessions[0].session,
    emitBeforeSwitch: async () => ({ cancelled: false }),
    teardownCurrent: async function () {
      teardowns += 1;
      await this.session.abort();
      this.session.dispose();
    },
    apply(result) {
      this.session = result.session;
    },
    finishSessionReplacement: async () => {},
  };

  try {
    await Promise.all(
      sessions.map(async ({ emit }, index) => {
        emit({ type: "agent_start" });
        await Promise.resolve();
        emit({ type: "tool_execution_update", toolCallId: `load-tool-${index}` });
      }),
    );

    for (const { sessionId } of sessions)
      assert.deepEqual(
        await peer.AgentSessionRuntime.prototype.switchSession.call(runtimeHost, `pi-gentic-live:${sessionId}`, {}),
        { cancelled: false },
      );

    assert.equal(teardowns, 0);
    assert.equal(
      sessions.every(({ sessionId }) => state.liveRuntimes.has(sessionId)),
      true,
    );
    assert.equal(
      sessions.every(({ runtime }) => typeof runtime.lastActivityAt === "string"),
      true,
    );
    assert.equal(
      calls.every(({ id }) => state.activeCalls.has(id)),
      true,
    );
    assert.equal(await abortAgentCallsForSession(rootSessionId), sessionCount);
    assert.equal(new Set(aborted).size, sessionCount);
    assert.ok(performance.now() - startedAt < 2_000);
  } finally {
    calls.forEach((call) => call.unregister());
    sessions.forEach(({ sessionId }) => {
      state.liveRuntimes.delete(sessionId);
      deleteRuntimeSession(sessionId);
    });
  }
});

test("live resume falls back to the persisted session when a run settles after selection", async () => {
  await installLiveSessionBridge();
  const peer = await loadPiCodingAgentPeer();
  const state = getLiveRuntimeState();
  const sessionId = "settled-resume-target";
  const sessionFile = "settled-resume-target.jsonl";
  const target = {
    isStreaming: false,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
    },
  };
  const originalSwitch = state.hostSwitchSession;
  const visibleContexts = [];
  let switchedPath;

  state.hostSwitchSession = async (path, options) => {
    switchedPath = path;
    await options.withSession?.({ marker: "persisted-target-context" });
    return { cancelled: false };
  };
  setRuntimeSession(sessionId, { session: target });
  state.liveRuntimes.delete(sessionId);

  try {
    assert.deepEqual(
      await peer.AgentSessionRuntime.prototype.switchSession.call({}, `pi-gentic-live:${sessionId}`, {
        withSession: (ctx) => visibleContexts.push(ctx),
      }),
      { cancelled: false },
    );
    assert.equal(switchedPath, sessionFile);
    assert.deepEqual(visibleContexts, [{ marker: "persisted-target-context" }]);
    assert.equal(state.activeContext.marker, "persisted-target-context");
  } finally {
    state.hostSwitchSession = originalSwitch;
    deleteRuntimeSession(sessionId);
  }
});

test("native parent abort reaches every active descendant branch", async () => {
  await installLiveSessionBridge();
  const peer = await loadPiCodingAgentPeer();
  const state = getLiveRuntimeState();
  const originalAbort = state.hostAbortSession;
  const aborted = [];
  const calls = [
    registerAgentCall({
      callerSessionId: "abort-tree-root",
      targetSessionId: "abort-tree-child-a",
      abort: () => aborted.push("child-a"),
    }),
    registerAgentCall({
      callerSessionId: "abort-tree-root",
      targetSessionId: "abort-tree-child-b",
      abort: () => aborted.push("child-b"),
    }),
    registerAgentCall({
      callerSessionId: "abort-tree-child-a",
      targetSessionId: "abort-tree-grandchild",
      abort: () => aborted.push("grandchild"),
    }),
  ];
  let parentAborts = 0;

  state.hostAbortSession = async () => {
    parentAborts += 1;
  };

  try {
    await peer.AgentSession.prototype.abort.call({
      sessionManager: { getSessionId: () => "abort-tree-root" },
    });

    assert.equal(parentAborts, 1);
    assert.deepEqual(new Set(aborted), new Set(["child-a", "child-b", "grandchild"]));
    assert.equal(state.activeCalls.has(calls[0].id), false);
    assert.equal(state.activeCalls.has(calls[1].id), false);
    assert.equal(state.activeCalls.has(calls[2].id), false);
  } finally {
    state.hostAbortSession = originalAbort;
    calls.forEach((call) => call.unregister());
  }
});

test("parent abort reaches active descendants after an intermediate delegation settles", async () => {
  const aborted = [];
  const sessions = [
    ["settled-tree-root", {}],
    ["settled-tree-child", { parentSessionId: "settled-tree-root" }],
    ["settled-tree-grandchild", { parentSessionId: "settled-tree-child" }],
  ];

  for (const [sessionId, metadata] of sessions)
    setRuntimeSession(sessionId, {
      session: { sessionManager: { getSessionId: () => sessionId } },
      ...metadata,
    });
  const call = registerAgentCall({
    callerSessionId: "settled-tree-child",
    targetSessionId: "settled-tree-grandchild",
    abort: () => aborted.push("grandchild"),
  });

  try {
    assert.equal(await abortAgentCallsForSession("settled-tree-root"), 1);
    assert.deepEqual(aborted, ["grandchild"]);
  } finally {
    call.unregister();
    sessions.forEach(([sessionId]) => deleteRuntimeSession(sessionId));
  }
});

test("agent-call aborts cascade once through target sessions", async () => {
  const host = await import("../dist/pi-host.js");
  const aborted = [];
  const parent = host.registerAgentCall({
    callerSessionId: "root-caller",
    targetSessionId: "nested-target",
    abort: () => aborted.push("parent"),
  });
  const child = host.registerAgentCall({
    callerSessionId: "nested-target",
    targetSessionId: "leaf-target",
    abort: () => aborted.push("child"),
  });

  try {
    assert.equal(await host.abortAgentCallsForSession("root-caller"), 2);
    assert.deepEqual(aborted.sort(), ["child", "parent"]);
    assert.equal(await host.abortAgentCallsForSession("root-caller"), 0);
    assert.equal(await host.abortAgentCall("missing-call"), 0);
  } finally {
    parent.unregister();
    child.unregister();
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

  assert.equal(getRuntimeSession("activity-session").lastActivityAt, "2026-01-01T00:00:10.000Z");

  deleteRuntimeSession("activity-session");
});

test("runtime activity heartbeats track every meaningful live session event", () => {
  const originalNow = Date.now;
  let listener;
  let subscribed = 0;
  let unsubscribed = 0;
  const session = {
    sessionManager: { getSessionId: () => "heartbeat-session" },
    subscribe(nextListener) {
      subscribed += 1;
      listener = nextListener;
      return () => {
        unsubscribed += 1;
      };
    },
  };

  try {
    Date.now = () => 1_000;
    const runtime = setRuntimeSession("heartbeat-session", { session });

    Date.now = () => 2_000;
    listener({ type: "agent_start" });
    assert.equal(runtime.lastActivityAt, "1970-01-01T00:00:02.000Z");

    Date.now = () => 3_000;
    listener({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "working" }],
      },
    });
    assert.equal(runtime.lastActivityAt, "1970-01-01T00:00:03.000Z");

    setRuntimeSession("heartbeat-session", { session });
    assert.equal(subscribed, 1);
  } finally {
    deleteRuntimeSession("heartbeat-session");
    Date.now = originalNow;
  }

  assert.equal(unsubscribed, 1);
});

test("runtime activity tracking follows session replacement without leaking listeners", () => {
  const listeners = [];
  const unsubscribed = [];
  const trackedSession = (name) => ({
    sessionManager: { getSessionId: () => "replacement-session" },
    subscribe(listener) {
      listeners.push({ name, listener });
      return () => unsubscribed.push(name);
    },
  });
  const first = trackedSession("first");
  const second = trackedSession("second");

  try {
    const runtime = setRuntimeSession("replacement-session", { session: first });
    setRuntimeSession("replacement-session", { session: second });

    assert.deepEqual(unsubscribed, ["first"]);
    assert.equal(listeners.length, 2);
    assert.equal(runtime.session, second);
  } finally {
    deleteRuntimeSession("replacement-session");
  }

  assert.deepEqual(unsubscribed, ["first", "second"]);
});

test("the current extension API follows replacement and clears its stale reload context", () => {
  const api = { sendMessage() {} };
  const staleApi = { sendMessage() {} };
  const ctx = { sessionManager: { getSessionId: () => "current-api" } };

  setActiveVisibleExtension(api, ctx);

  assert.equal(clearActiveVisibleExtension(staleApi), false);
  assert.equal(activeVisibleExtension(), api);
  assert.equal(activeVisibleContext(), ctx);
  assert.equal(clearActiveVisibleExtension(api), true);
  assert.equal(activeVisibleExtension(), undefined);
  assert.equal(activeVisibleContext(), undefined);
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

  assert.equal(getRuntimeSession("visible-prompt-session").session.isStreaming, false);

  deleteRuntimeSession("visible-prompt-session");
});

test("switching during prompt preflight parks the submitted session", async () => {
  const state = getLiveRuntimeState();
  state.liveRuntimes.clear();
  let completePreflight;
  const preflight = new Promise((resolve) => {
    completePreflight = resolve;
  });
  let disposed = 0;
  const session = {
    isStreaming: false,
    dispose: () => {
      disposed += 1;
    },
    sessionManager: {
      getEntries: () => [],
      getHeader: () => ({}),
      getSessionId: () => "preflight-session",
    },
  };
  const runtimeHost = { session };
  const prompt = trackSessionPrompt(session, () => preflight, "Confirm");
  await Promise.resolve();
  const tracked = getRuntimeSession("preflight-session");
  const restore = parkCurrentLiveRuntimeForSwitch(state, runtimeHost);

  session.dispose();

  assert.equal(tracked.activePromptCount, 1);
  assert.equal(disposed, 0);
  assert.equal(state.liveRuntimes.get("preflight-session")?.runtime.session, session);

  restore();
  completePreflight();
  await prompt;
  assert.equal(tracked.activePromptCount, 0);
  deleteRuntimeSession("preflight-session");
  state.liveRuntimes.clear();
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
      path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js"),
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

    assert.deepEqual(prompts, ["message for opened session", "/review opened session"]);
    assert.deepEqual(history, ["message for opened session", "/review opened session"]);
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

test("current InteractiveMode hydrates an active streaming message after its native session render", async () => {
  const state = getLiveRuntimeState();

  await installBridgeForTest(state, "liveHydrationBridgeInstalled");
  const { InteractiveMode } = await import(
    pathToFileURL(
      path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js"),
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

test("AgentSession dispose cleans stale pi-gentic runtime references", async () => {
  const state = getLiveRuntimeState();

  state.liveRuntimes.clear();
  await installBridgeForTest(state, "disposeBridgeInstalled");
  const { AgentSession } = await import(
    pathToFileURL(path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js")).href
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
    pathToFileURL(path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js")).href
  );
  const sessionDir = mkdtempSync(path.join(tmpdir(), "pi-gentic-new-"));
  let disposed = 0;
  const session = {
    isStreaming: true,
    sessionFile: path.join(sessionDir, "running.jsonl"),
    abort: async () => {},
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
    assert.equal(state.liveRuntimes.get("new-running-session").runtime, runtimeHost);
  } finally {
    deleteRuntimeSession("new-running-session");
    state.liveRuntimes.clear();
  }
});

test("a submission made during /new waits for the new session", async () => {
  const state = getLiveRuntimeState();
  state.liveRuntimes.clear();
  await installBridgeForTest(state, "submitBridgeInstalled");
  const peer = await loadPiCodingAgentPeer();
  const originalNewSession = state.hostNewSession;
  const oldPrompts = [];
  const newPrompts = [];
  let finishReplacement;
  const replacement = new Promise((resolve) => {
    finishReplacement = resolve;
  });
  const oldSession = {
    isStreaming: true,
    prompt: async (...args) => oldPrompts.push(args),
    sessionManager: { getHeader: () => ({}), getSessionId: () => "transition-old-session" },
  };
  const newSession = {
    isStreaming: false,
    prompt: async (...args) => newPrompts.push(args),
    sessionManager: { getHeader: () => ({}), getSessionId: () => "transition-new-session" },
  };
  const runtimeHost = { session: oldSession };
  const history = [];
  const mode = Object.assign(Object.create(peer.InteractiveMode.prototype), {
    defaultEditor: {},
    editor: {
      text: "",
      addToHistory: (text) => history.push(text),
      getText() {
        return this.text;
      },
      setText(text) {
        this.text = text;
      },
    },
    flushPendingBashComponents() {},
    handleClearCommand: async () => {
      await peer.AgentSessionRuntime.prototype.newSession.call(runtimeHost);
    },
    onInputCallback: undefined,
    runtimeHost,
    ui: { requestRender() {} },
    updatePendingMessagesDisplay() {},
  });

  state.hostNewSession = async () => {
    await replacement;
    runtimeHost.session = newSession;
    return { cancelled: false };
  };
  setRuntimeSession("transition-old-session", { runtimeHost, session: oldSession });

  try {
    mode.setupEditorSubmitHandler();
    const startNewSession = mode.defaultEditor.onSubmit("/new");
    await Promise.resolve();
    const submitMessage = mode.defaultEditor.onSubmit("message for the new session");
    await Promise.resolve();

    assert.deepEqual(oldPrompts, []);
    assert.deepEqual(newPrompts, []);

    finishReplacement();
    await Promise.all([startNewSession, submitMessage]);

    assert.deepEqual(oldPrompts, []);
    assert.deepEqual(newPrompts, [["message for the new session"]]);
    assert.deepEqual(history, ["message for the new session"]);
  } finally {
    finishReplacement();
    state.hostNewSession = originalNewSession;
    deleteRuntimeSession("transition-old-session");
    deleteRuntimeSession("transition-new-session");
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
  const lastActivityAt = "2026-07-18T09:54:05.060Z";

  setRuntimeSession("running-session", {
    runtimeHost,
    session,
    lastActivityAt,
  });
  const restore = parkCurrentLiveRuntimeForSwitch(state, runtimeHost);

  session.dispose();

  assert.equal(disposed, 0);

  assert.equal(state.liveRuntimes.get("running-session").runtime, runtimeHost);
  assert.equal(getRuntimeSession("running-session").lastActivityAt, lastActivityAt);

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

  assert.equal(state.liveRuntimes.get("visible-running-session").runtime.session, session);

  runtimeHost.session = {
    sessionManager: { getSessionId: () => "next-session" },
  };

  assert.equal(state.liveRuntimes.get("visible-running-session").runtime.session, session);

  restore();
  session.dispose();

  assert.equal(disposed, 1);
});

async function installBridgeForTest(state, flag) {
  process.env.PI_CLI = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  await installLiveSessionBridge();

  assert.equal(state[flag], true);
}
