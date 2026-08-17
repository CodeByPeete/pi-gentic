import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPiHostCapabilities,
  getLiveRuntimeState,
  installPiHost,
  loadPiCodingAgentPeer,
  piHostDiagnostics,
} from "../dist/infrastructure/pi/host.js";

function requiredHostPeer() {
  return {
    AgentSession: {
      prototype: {
        abort() {},
        prompt() {},
        dispose() {},
      },
    },
    AgentSessionRuntime: {
      prototype: {
        switchSession() {},
        newSession() {},
        fork() {},
        importFromJsonl() {},
      },
    },
    InteractiveMode: {
      prototype: {
        setupEditorSubmitHandler() {},
        setupKeyHandlers() {},
        handleFollowUp() {},
        renderCurrentSessionState() {},
      },
    },
  };
}

test("the Pi host reports every missing required capability", () => {
  assert.throws(
    () =>
      assertPiHostCapabilities({
        ...requiredHostPeer(),
        AgentSession: { prototype: {} },
        AgentSessionRuntime: { prototype: {} },
        InteractiveMode: { prototype: {} },
      }),
    /AgentSessionRuntime\.switchSession.*AgentSession\.abort.*InteractiveMode\.renderCurrentSessionState/i,
  );
});

test("the installed Pi host satisfies the required contract", async () => {
  const peer = await loadPiCodingAgentPeer();

  assert.doesNotThrow(() => assertPiHostCapabilities(peer));
});

test("host installation removes errors that the current host no longer produces", async () => {
  const state = getLiveRuntimeState();
  const previousDiagnostics = [...state.hostDiagnostics];
  state.hostDiagnostics.splice(0, state.hostDiagnostics.length, "stale session loading failure");

  try {
    await installPiHost();

    assert.equal(piHostDiagnostics().includes("stale session loading failure"), false);
  } finally {
    state.hostDiagnostics.splice(0, state.hostDiagnostics.length, ...previousDiagnostics);
  }
});
