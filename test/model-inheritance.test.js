import assert from "node:assert/strict";
import test from "node:test";
import {
  applyInheritedModel,
  inheritedModelForPolicy,
} from "../dist/pi-host.js";

test("agentless child sessions inherit the active model when policy has no model", () => {
  assert.deepEqual(
    inheritedModelForPolicy(
      {},
      { provider: "openai-codex", id: "gpt-5.4-mini" },
    ),
    {
      provider: "openai-codex",
      id: "gpt-5.4-mini",
    },
  );
});

test("configured policy model blocks inherited model", () => {
  assert.equal(
    inheritedModelForPolicy(
      { model: "openai-codex/gpt-5.4" },
      { provider: "openai-codex", id: "gpt-5.4-mini" },
    ),
    undefined,
  );
});

test("inherited model is resolved through the target session registry", async () => {
  const selected = {
    provider: "openai-codex",
    id: "gpt-5.4-mini",
    label: "registry model",
  };
  const applied = [];
  const model = await applyInheritedModel(
    {
      modelRegistry: {
        find: (provider, id) =>
          provider === selected.provider && id === selected.id
            ? selected
            : undefined,
      },
      setModel: async (next) => applied.push(next),
    },
    {},
    { provider: "openai-codex", id: "gpt-5.4-mini" },
  );

  assert.equal(model, selected);

  assert.deepEqual(applied, [selected]);
});

test("inherited model does not append a duplicate model change", async () => {
  const selected = { provider: "openai-codex", id: "gpt-5.4-mini" };
  const applied = [];
  const model = await applyInheritedModel(
    {
      model: selected,
      modelRegistry: { find: () => selected },
      setModel: async (next) => applied.push(next),
    },
    {},
    selected,
  );

  assert.equal(model, selected);

  assert.deepEqual(applied, []);
});
