import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_CYCLE_SHORTCUT,
  configuredDefaultAgent,
  nextAgentName,
  shouldApplyDefaultAgent,
} from "../dist/catalog.js";

test("agent cycle includes cleared state before configured agents", () => {
  const agents = [{ name: "builder" }, { name: "researcher" }];

  assert.equal(nextAgentName(undefined, agents), "builder");

  assert.equal(nextAgentName("builder", agents), "researcher");

  assert.equal(nextAgentName("researcher", agents), undefined);
});

test("agent cycle recovers from stale active agent names", () => {
  assert.equal(nextAgentName("missing", [{ name: "builder" }]), "builder");
});

test("default agent applies only to fresh startup and new sessions", () => {
  assert.equal(
    shouldApplyDefaultAgent({ reason: "startup" }, { getEntries: () => [] }),
    true,
  );

  assert.equal(
    shouldApplyDefaultAgent({ reason: "new" }, { getEntries: () => [] }),
    true,
  );

  assert.equal(
    shouldApplyDefaultAgent(
      { reason: "startup" },
      {
        getEntries: () => [{ type: "model_change" }],
        buildSessionContext: () => ({ messages: [] }),
      },
    ),
    true,
  );

  assert.equal(
    shouldApplyDefaultAgent({ reason: "resume" }, { getEntries: () => [] }),
    false,
  );

  assert.equal(
    shouldApplyDefaultAgent(
      { reason: "new" },
      {
        getEntries: () => [
          {
            type: "custom",
            customType: "pi-gentic:state",
            data: { agentName: "builder" },
          },
        ],
      },
    ),
    false,
  );

  assert.equal(
    shouldApplyDefaultAgent(
      { reason: "startup" },
      {
        getEntries: () => [
          { type: "message", message: { role: "user", content: "hello" } },
        ],
      },
    ),
    false,
  );
});

test("agent cycle shortcut uses a simple VSCode-friendly key", () => {
  assert.equal(AGENT_CYCLE_SHORTCUT, "f7");
});

test("default agent setting accepts names and treats null or empty values as disabled", () => {
  assert.equal(
    configuredDefaultAgent({ defaultAgent: " researcher " }),
    "researcher",
  );

  assert.equal(configuredDefaultAgent({ defaultAgent: null }), undefined);

  assert.equal(configuredDefaultAgent({ defaultAgent: "" }), undefined);
});
