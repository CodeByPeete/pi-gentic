import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteRuntimeSession,
  getLiveRuntimeState,
  loadPiCodingAgentPeer,
  setRuntimeSession,
} from "../dist/infrastructure/pi/host.js";
import {
  createTransitionMode,
  installPiHostForTest,
  settlesBeforeNextTurn,
  waitForCondition,
} from "./support/pi-host.js";

test("submissions during /new appear immediately and enter the new session when it is ready", async () => {
  const state = getLiveRuntimeState();
  state.liveRuntimes.clear();
  await installPiHostForTest(state, "interactiveSubmitInstalled");
  const peer = await loadPiCodingAgentPeer();
  const originalNewSession = state.hostNewSession;
  const oldPrompts = [];
  const newPrompts = [];
  const ready = Promise.withResolvers();
  const finishOperation = Promise.withResolvers();
  const oldSession = {
    isStreaming: true,
    prompt: async (...args) => oldPrompts.push(args),
    sessionManager: { getHeader: () => ({}), getSessionId: () => "transition-old-session" },
  };
  const newSession = {
    isStreaming: false,
    prompt: async (...args) => {
      newPrompts.push(args);
      newSession.isStreaming = true;
    },
    sessionManager: { getHeader: () => ({}), getSessionId: () => "transition-new-session" },
  };
  const runtimeHost = { session: oldSession };
  const { history, mode, statuses } = createTransitionMode(peer, runtimeHost);

  state.hostNewSession = async (_options) => {
    await ready.promise;
    runtimeHost.session = newSession;
    await _options.withSession({ marker: "new context" });
    await finishOperation.promise;
    return { cancelled: false };
  };
  setRuntimeSession("transition-old-session", { runtimeHost, session: oldSession });

  try {
    mode.setupEditorSubmitHandler();
    const startNewSession = mode.defaultEditor.onSubmit("/new");
    await Promise.resolve();
    let firstReturned = false;
    let secondReturned = false;
    const first = mode.defaultEditor.onSubmit("first message").then(() => {
      firstReturned = true;
    });
    const second = mode.defaultEditor.onSubmit("second message").then(() => {
      secondReturned = true;
    });
    const returnedImmediately = await settlesBeforeNextTurn(Promise.all([first, second]));

    assert.equal(returnedImmediately, true);
    assert.equal(firstReturned, true);
    assert.equal(secondReturned, true);
    assert.match(statuses.at(-1), /2 messages queued for new session/i);
    assert.deepEqual(oldPrompts, []);
    assert.deepEqual(newPrompts, []);

    ready.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(oldPrompts, []);
    assert.deepEqual(newPrompts, [["first message"], ["second message", { streamingBehavior: "steer" }]]);
    assert.deepEqual(history, ["first message", "second message"]);

    let transitionFinished = false;
    startNewSession.then(() => {
      transitionFinished = true;
    });
    await Promise.resolve();
    assert.equal(transitionFinished, false);

    finishOperation.resolve();
    await startNewSession;
  } finally {
    ready.resolve();
    finishOperation.resolve();
    state.hostNewSession = originalNewSession;
    deleteRuntimeSession("transition-old-session");
    deleteRuntimeSession("transition-new-session");
    state.liveRuntimes.clear();
  }
});

test("rapid chained session changes preserve input order in the final destination", async () => {
  const state = getLiveRuntimeState();
  state.liveRuntimes.clear();
  await installPiHostForTest(state, "interactiveSubmitInstalled");
  const peer = await loadPiCodingAgentPeer();
  const originalNewSession = state.hostNewSession;
  const ready = [Promise.withResolvers(), Promise.withResolvers()];
  const oldPrompts = [];
  const firstPrompts = [];
  const secondPrompts = [];
  const oldSession = {
    isStreaming: true,
    prompt: async (...args) => oldPrompts.push(args),
    sessionManager: { getHeader: () => ({}), getSessionId: () => "chain-old-session" },
  };
  const sessions = [
    {
      isStreaming: false,
      prompt: async (...args) => firstPrompts.push(args),
      sessionManager: { getHeader: () => ({}), getSessionId: () => "chain-first-session" },
    },
    {
      isStreaming: false,
      prompt: async (...args) => {
        secondPrompts.push(args);
        sessions[1].isStreaming = true;
      },
      sessionManager: { getHeader: () => ({}), getSessionId: () => "chain-second-session" },
    },
  ];
  const runtimeHost = { session: oldSession };
  const { mode } = createTransitionMode(peer, runtimeHost);
  let replacementCount = 0;

  state.hostNewSession = async (options) => {
    const index = replacementCount++;
    await ready[index].promise;
    runtimeHost.session = sessions[index];
    await options.withSession({});
    return { cancelled: false };
  };
  setRuntimeSession("chain-old-session", { runtimeHost, session: oldSession });

  try {
    mode.setupEditorSubmitHandler();
    const firstReplacement = mode.defaultEditor.onSubmit("/new");
    await Promise.resolve();
    await mode.defaultEditor.onSubmit("/new");
    await mode.defaultEditor.onSubmit("first final message");

    ready[0].resolve();
    await waitForCondition(() => replacementCount >= 2, "the queued /new command did not start the final replacement");
    await mode.defaultEditor.onSubmit("second final message");
    ready[1].resolve();
    await firstReplacement;

    assert.deepEqual(oldPrompts, []);
    assert.deepEqual(firstPrompts, []);
    assert.deepEqual(secondPrompts, [
      ["first final message"],
      ["second final message", { streamingBehavior: "steer" }],
    ]);
  } finally {
    ready[0].resolve();
    ready[1].resolve();
    state.hostNewSession = originalNewSession;
    deleteRuntimeSession("chain-old-session");
    state.liveRuntimes.clear();
  }
});

test("a cancelled session change restores queued input without sending it to the old session", async () => {
  const state = getLiveRuntimeState();
  state.liveRuntimes.clear();
  await installPiHostForTest(state, "interactiveSubmitInstalled");
  const peer = await loadPiCodingAgentPeer();
  const originalNewSession = state.hostNewSession;
  const finishCancellation = Promise.withResolvers();
  const oldPrompts = [];
  const oldSession = {
    isStreaming: true,
    prompt: async (...args) => oldPrompts.push(args),
    sessionManager: { getHeader: () => ({}), getSessionId: () => "cancelled-transition-session" },
  };
  const runtimeHost = { session: oldSession };
  const { mode, statuses } = createTransitionMode(peer, runtimeHost);

  state.hostNewSession = async () => {
    await finishCancellation.promise;
    return { cancelled: true };
  };

  try {
    mode.setupEditorSubmitHandler();
    const startNewSession = mode.defaultEditor.onSubmit("/new");
    await Promise.resolve();
    const queuedSubmission = mode.defaultEditor.onSubmit("keep this message");
    const returnedImmediately = await settlesBeforeNextTurn(queuedSubmission);
    assert.equal(returnedImmediately, true);
    mode.editor.setText("current draft");

    finishCancellation.resolve();
    await startNewSession;

    assert.deepEqual(oldPrompts, []);
    assert.equal(mode.editor.getText(), "keep this message\n\ncurrent draft");
    assert.match(statuses.at(-1), /restored 1 queued message/i);
  } finally {
    finishCancellation.resolve();
    state.hostNewSession = originalNewSession;
    state.liveRuntimes.clear();
  }
});

test("Escape restores queued input without cancelling the destination session", async () => {
  const state = getLiveRuntimeState();
  state.liveRuntimes.clear();
  await installPiHostForTest(state, "interactiveEscapeInstalled");
  const peer = await loadPiCodingAgentPeer();
  const originalNewSession = state.hostNewSession;
  const originalSetupKeyHandlers = state.hostSetupKeyHandlers;
  const ready = Promise.withResolvers();
  const oldPrompts = [];
  const newPrompts = [];
  let nativeEscapes = 0;
  const oldSession = {
    isStreaming: true,
    prompt: async (...args) => oldPrompts.push(args),
    sessionManager: { getHeader: () => ({}), getSessionId: () => "escape-transition-old" },
  };
  const newSession = {
    isStreaming: false,
    prompt: async (...args) => newPrompts.push(args),
    sessionManager: { getHeader: () => ({}), getSessionId: () => "escape-transition-new" },
  };
  const runtimeHost = { session: oldSession };
  const { mode, statuses } = createTransitionMode(peer, runtimeHost);

  state.hostSetupKeyHandlers = function () {
    this.defaultEditor.onEscape = () => {
      nativeEscapes += 1;
    };
  };
  state.hostNewSession = async (options) => {
    await ready.promise;
    runtimeHost.session = newSession;
    await options.withSession({});
    return { cancelled: false };
  };

  try {
    mode.setupEditorSubmitHandler();
    mode.setupKeyHandlers();
    const startNewSession = mode.defaultEditor.onSubmit("/new");
    await Promise.resolve();
    await mode.defaultEditor.onSubmit("restore with Escape");
    mode.editor.setText("current draft");

    mode.defaultEditor.onEscape();

    assert.equal(nativeEscapes, 0);
    assert.equal(mode.editor.getText(), "restore with Escape\n\ncurrent draft");
    assert.match(statuses.at(-1), /queued delivery was cancelled/i);

    ready.resolve();
    await startNewSession;
    assert.deepEqual(oldPrompts, []);
    assert.deepEqual(newPrompts, []);
  } finally {
    ready.resolve();
    state.hostNewSession = originalNewSession;
    state.hostSetupKeyHandlers = originalSetupKeyHandlers;
    state.liveRuntimes.clear();
  }
});

test("a failed session change restores every unsent message", async () => {
  const state = getLiveRuntimeState();
  state.liveRuntimes.clear();
  await installPiHostForTest(state, "interactiveSubmitInstalled");
  const peer = await loadPiCodingAgentPeer();
  const originalNewSession = state.hostNewSession;
  const finishFailure = Promise.withResolvers();
  const oldPrompts = [];
  const oldSession = {
    isStreaming: true,
    prompt: async (...args) => oldPrompts.push(args),
    sessionManager: { getHeader: () => ({}), getSessionId: () => "failed-transition-session" },
  };
  const runtimeHost = { session: oldSession };
  const { mode, statuses } = createTransitionMode(peer, runtimeHost);

  state.hostNewSession = async () => {
    await finishFailure.promise;
    throw new Error("replacement failed");
  };

  try {
    mode.setupEditorSubmitHandler();
    const startNewSession = mode.defaultEditor.onSubmit("/new");
    await Promise.resolve();
    await mode.defaultEditor.onSubmit("first unsent message");
    await mode.defaultEditor.onSubmit("second unsent message");

    finishFailure.resolve();
    await assert.rejects(startNewSession, /replacement failed/);

    assert.deepEqual(oldPrompts, []);
    assert.equal(mode.editor.getText(), "first unsent message\n\nsecond unsent message");
    assert.match(statuses.at(-1), /restored 2 queued messages/i);
  } finally {
    finishFailure.resolve();
    state.hostNewSession = originalNewSession;
    state.liveRuntimes.clear();
  }
});

test("Alt+Enter during a session change preserves follow-up delivery", async () => {
  const state = getLiveRuntimeState();
  state.liveRuntimes.clear();
  await installPiHostForTest(state, "interactiveFollowUpInstalled");
  const peer = await loadPiCodingAgentPeer();
  const originalNewSession = state.hostNewSession;
  const ready = Promise.withResolvers();
  const oldPrompts = [];
  const newPrompts = [];
  const oldSession = {
    isStreaming: true,
    prompt: async (...args) => oldPrompts.push(args),
    sessionManager: { getHeader: () => ({}), getSessionId: () => "follow-up-old-session" },
  };
  const newSession = {
    isStreaming: true,
    prompt: async (...args) => newPrompts.push(args),
    sessionManager: { getHeader: () => ({}), getSessionId: () => "follow-up-new-session" },
  };
  const runtimeHost = { session: oldSession };
  const { history, mode } = createTransitionMode(peer, runtimeHost);

  state.hostNewSession = async (options) => {
    await ready.promise;
    runtimeHost.session = newSession;
    await options.withSession({});
    return { cancelled: false };
  };
  setRuntimeSession("follow-up-old-session", { runtimeHost, session: oldSession });

  try {
    mode.setupEditorSubmitHandler();
    const startNewSession = mode.defaultEditor.onSubmit("/new");
    await Promise.resolve();
    mode.editor.setText("follow up in the new session");
    await mode.handleFollowUp();

    assert.deepEqual(oldPrompts, []);
    ready.resolve();
    await startNewSession;

    assert.deepEqual(oldPrompts, []);
    assert.deepEqual(newPrompts, [["follow up in the new session", { streamingBehavior: "followUp" }]]);
    assert.deepEqual(history, ["follow up in the new session"]);
  } finally {
    ready.resolve();
    state.hostNewSession = originalNewSession;
    deleteRuntimeSession("follow-up-old-session");
    state.liveRuntimes.clear();
  }
});

for (const replacement of [
  {
    destination: "selected session",
    field: "hostSwitchSession",
    flag: "switchSessionInstalled",
    invoke: (peer, runtimeHost) =>
      peer.AgentSessionRuntime.prototype.switchSession.call(runtimeHost, "persisted-session.jsonl"),
  },
  {
    destination: "forked session",
    field: "hostForkSession",
    flag: "forkSessionInstalled",
    invoke: (peer, runtimeHost) => peer.AgentSessionRuntime.prototype.fork.call(runtimeHost, "entry-id"),
  },
  {
    destination: "imported session",
    field: "hostImportSession",
    flag: "importSessionInstalled",
    invoke: (peer, runtimeHost) =>
      peer.AgentSessionRuntime.prototype.importFromJsonl.call(runtimeHost, "session.jsonl"),
  },
]) {
  test(`input follows the ${replacement.destination} replacement`, async () => {
    const state = getLiveRuntimeState();
    state.liveRuntimes.clear();
    await installPiHostForTest(state, replacement.flag);
    const peer = await loadPiCodingAgentPeer();
    const originalReplacement = state[replacement.field];
    const ready = Promise.withResolvers();
    const oldPrompts = [];
    const newPrompts = [];
    const oldSession = {
      isStreaming: true,
      prompt: async (...args) => oldPrompts.push(args),
      sessionManager: { getHeader: () => ({}), getSessionId: () => `${replacement.field}-old` },
    };
    const newSession = {
      isStreaming: false,
      prompt: async (...args) => newPrompts.push(args),
      sessionManager: { getHeader: () => ({}), getSessionId: () => `${replacement.field}-new` },
    };
    const runtimeHost = { session: oldSession };
    const { mode, statuses } = createTransitionMode(peer, runtimeHost);

    state[replacement.field] = async (...args) => {
      await ready.promise;
      runtimeHost.session = newSession;
      const options = args.find((value) => value && typeof value === "object" && "withSession" in value);
      await options?.withSession?.({});
      return { cancelled: false };
    };
    setRuntimeSession(`${replacement.field}-old`, { runtimeHost, session: oldSession });

    try {
      mode.setupEditorSubmitHandler();
      const startReplacement = replacement.invoke(peer, runtimeHost);
      await Promise.resolve();
      await mode.defaultEditor.onSubmit(`message for the ${replacement.destination}`);

      assert.match(statuses.at(-1), new RegExp(`queued for ${replacement.destination}`, "i"));
      assert.deepEqual(oldPrompts, []);
      ready.resolve();
      await startReplacement;

      assert.deepEqual(oldPrompts, []);
      assert.deepEqual(newPrompts, [[`message for the ${replacement.destination}`]]);
    } finally {
      ready.resolve();
      state[replacement.field] = originalReplacement;
      deleteRuntimeSession(`${replacement.field}-old`);
      state.liveRuntimes.clear();
    }
  });
}
