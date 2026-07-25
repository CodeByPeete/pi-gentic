import assert from "node:assert/strict";
import test from "node:test";
import { assertLegacyHostCompatible, loadPiCodingAgentPeer } from "../dist/pi-host.js";

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
  assert.throws(() => assertLegacyHostCompatible(compatiblePeer("0.83.0")), /supports Pi 0\.82\.1.*received 0\.83\.0/i);
});

test("the legacy bridge reports every missing host capability", () => {
  assert.throws(
    () =>
      assertLegacyHostCompatible({
        ...compatiblePeer("0.82.1"),
        AgentSession: { prototype: {} },
        AgentSessionRuntime: { prototype: {} },
        InteractiveMode: { prototype: {} },
      }),
    /AgentSessionRuntime\.switchSession.*AgentSession\.abort.*InteractiveMode\.renderCurrentSessionState/i,
  );
});

test("the installed Pi peer reports the exact compatibility version", async () => {
  const peer = await loadPiCodingAgentPeer();

  assert.equal(peer.version, "0.82.1");
  assert.doesNotThrow(() => assertLegacyHostCompatible(peer));
});
