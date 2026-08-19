import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { FastCheck } from "effect/testing";
import { applyCapabilityFilter, reconcileActiveToolSelection } from "../../src/sessions/policy.js";

const names = FastCheck.uniqueArray(FastCheck.stringMatching(/^[a-z][a-z0-9_-]{0,12}$/), { maxLength: 20 });
const selectionCases: Array<[string, string[], string[], string[], string[]]> = [
  [
    "preserves wildcard ambient tools",
    ["read", "bash", "exec_command", "apply_patch", "agents"],
    ["exec_command", "apply_patch", "agents"],
    ["*"],
    ["exec_command", "apply_patch", "agents"],
  ],
  ["subtracts exclusions", ["read", "write", "agents"], ["write", "agents"], ["!write"], ["agents"]],
  [
    "applies additions before removals",
    ["read", "write", "agents", "view_image"],
    ["agents"],
    ["*", "+VIEW_IMAGE", "+write", "-view_image"],
    ["agents", "write"],
  ],
  [
    "selects patterns in catalog order",
    ["write", "read_file", "read", "agents"],
    ["agents", "write"],
    ["read*", "+agents"],
    ["read_file", "read", "agents"],
  ],
  ["selects nothing for an empty policy", ["read", "agents"], ["agents"], [], []],
  [
    "ignores unknown and duplicate names",
    ["read", "agents"],
    ["agents", "missing", "agents"],
    ["*", "+missing", "+read", "+READ"],
    ["agents", "read"],
  ],
];

describe("CapabilitySet", () => {
  it.effect("tracks, restores, replaces, and prunes ambient selections", () =>
    Effect.sync(() => {
      const registeredToolNames = ["read", "exec_command", "view_image", "agents"];
      const restricted = reconcileActiveToolSelection({
        registeredToolNames,
        observedToolNames: ["exec_command", "agents"],
        filters: ["agents"],
      });
      const released = reconcileActiveToolSelection({
        registeredToolNames,
        observedToolNames: restricted.selection,
        filters: ["*"],
        previousState: restricted.state,
      });
      const replaced = reconcileActiveToolSelection({
        registeredToolNames,
        observedToolNames: ["view_image", "agents"],
        filters: ["*"],
        previousState: restricted.state,
      });
      const pruned = reconcileActiveToolSelection({
        registeredToolNames: ["agents"],
        observedToolNames: ["agents"],
        filters: ["*"],
        previousState: restricted.state,
      });

      assert.deepStrictEqual(restricted, {
        selection: ["agents"],
        changed: true,
        state: { ambientToolNames: ["exec_command", "agents"], appliedToolNames: ["agents"] },
      });
      assert.deepStrictEqual(released.selection, ["exec_command", "agents"]);
      assert.deepStrictEqual(replaced.state, {
        ambientToolNames: ["view_image", "agents"],
        appliedToolNames: ["view_image", "agents"],
      });
      assert.deepStrictEqual(pruned.state, { ambientToolNames: ["agents"], appliedToolNames: ["agents"] });
    }),
  );

  it.effect.each(selectionCases)("%s", ([_name, registered, observed, filters, expected]) =>
    Effect.sync(() => {
      const result = reconcileActiveToolSelection({
        registeredToolNames: registered,
        observedToolNames: observed,
        filters,
      });

      assert.deepStrictEqual(result.selection, expected);
    }),
  );

  it.effect.prop(
    "force inclusion cannot create a capability absent from the ceiling",
    [names, FastCheck.stringMatching(/^[a-z][a-z0-9_-]{0,12}$/)],
    ([ambient, unavailable]) =>
      Effect.sync(() => {
        const ceiling = ambient.filter((name) => name !== unavailable);
        const resolved = applyCapabilityFilter(ceiling, [`+${unavailable}`]);

        assert.isFalse(resolved.includes(unavailable));
      }),
  );

  it.effect("preserves ambient ordering and handles empty restrictions", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(applyCapabilityFilter(["read", "write"], undefined), ["read", "write"]);
      assert.deepStrictEqual(applyCapabilityFilter(["read", "write"], ["read", "+write", "-read"]), ["write"]);
      assert.deepStrictEqual(applyCapabilityFilter(["write", "read"], ["read", "+write"]), ["write", "read"]);
    }),
  );
});
