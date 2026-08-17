import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLegacyHostCompatible,
  getLiveRuntimeState,
  hostCompatibilityDiagnostics,
  installLiveSessionBridge,
  loadPiCodingAgentPeer,
} from "../dist/pi-host.js";

function compatiblePeer(version) {
  return {
    version,
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
      },
    },
    InteractiveMode: {
      prototype: {
        setupEditorSubmitHandler() {},
        setupKeyHandlers() {},
        renderCurrentSessionState() {},
      },
    },
  };
}

test("the legacy bridge rejects unknown Pi versions before installation", () => {
  assert.throws(() => assertLegacyHostCompatible(compatiblePeer("0.84.0")), /supports Pi 0\.84\.2.*received 0\.84\.0/i);
});

test("the legacy bridge reports every missing host capability", () => {
  assert.throws(
    () =>
      assertLegacyHostCompatible({
        ...compatiblePeer("0.84.2"),
        AgentSession: { prototype: {} },
        AgentSessionRuntime: { prototype: {} },
        InteractiveMode: { prototype: {} },
      }),
    /AgentSessionRuntime\.switchSession.*AgentSession\.abort.*InteractiveMode\.renderCurrentSessionState/i,
  );
});

test("the installed Pi peer reports the exact compatibility version", async () => {
  const peer = await loadPiCodingAgentPeer();

  assert.equal(peer.version, "0.84.2");
  assert.doesNotThrow(() => assertLegacyHostCompatible(peer));
});

test("the legacy bridge removes compatibility errors that the current host no longer produces", async () => {
  const state = getLiveRuntimeState();
  const previousDiagnostics = [...state.compatibilityDiagnostics];
  state.compatibilityDiagnostics.splice(0, state.compatibilityDiagnostics.length, "stale session loading failure");

  try {
    await installLiveSessionBridge();

    assert.equal(hostCompatibilityDiagnostics().includes("stale session loading failure"), false);
  } finally {
    state.compatibilityDiagnostics.splice(0, state.compatibilityDiagnostics.length, ...previousDiagnostics);
  }
});
