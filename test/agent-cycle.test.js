import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_CYCLE_SHORTCUT,
  appendActiveState,
  configuredDefaultAgent,
  getActiveState,
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

test("invalid persisted agent state falls back to the latest valid entry", () => {
  const state = getActiveState({
    getEntries: () => [
      {
        type: "custom",
        customType: "pi-gentic:state",
        data: { agentName: "builder", overrides: { tools: ["read"] } },
      },
      {
        type: "custom",
        customType: "pi-gentic:state",
        data: { agentName: 42 },
      },
    ],
  });

  assert.deepEqual(state, {
    agentName: "builder",
    overrides: { tools: ["read"] },
  });
});

test("persisted state readers ignore non-entry values", () => {
  const sessionManager = {
    getEntries: () => [null, 42, { type: "branch_summary" }],
  };

  assert.deepEqual(getActiveState(sessionManager), {
    agentName: undefined,
    overrides: undefined,
  });
  assert.equal(
    shouldApplyDefaultAgent({ reason: "startup" }, sessionManager),
    true,
  );
});

test("active state persistence requires a writable native session", () => {
  assert.throws(
    () => appendActiveState({ getEntries: () => [] }, { agentName: "builder" }),
    /does not support custom state entries/i,
  );
});

test("active agent state preserves a name when overrides are undefined", () => {
  let persisted;

  appendActiveState(
    { appendCustomEntry: (_type, data) => (persisted = data) },
    { agentName: "reviewer", overrides: undefined },
  );

  assert.equal(persisted.agentName, "reviewer");
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
