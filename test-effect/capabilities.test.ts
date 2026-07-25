import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { FastCheck } from "effect/testing";
import {
  applyCapabilityFilter,
  reconcileActiveToolSelection,
  resolveCapabilitySet,
} from "../src/domain/capabilities.js";

const names = FastCheck.uniqueArray(FastCheck.stringMatching(/^[a-z][a-z0-9_-]{0,12}$/), { maxLength: 20 });
const filters = FastCheck.array(
  FastCheck.tuple(FastCheck.constantFrom("", "+", "-", "!"), FastCheck.stringMatching(/^[a-z][a-z0-9_*?-]{0,12}$/)).map(
    ([prefix, name]) => `${prefix}${name}`,
  ),
  { maxLength: 20 },
);

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

  it.effect.each([
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
  ])("%s", ([_name, registered, observed, filters, expected]) =>
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
    "resolved capabilities always remain inside the ambient ceiling",
    [names, FastCheck.array(filters, { maxLength: 5 })],
    ([ambient, layers]) =>
      Effect.sync(() => {
        const resolved = resolveCapabilitySet(ambient, layers);

        assert.isTrue(resolved.every((name) => ambient.includes(name)));
      }),
  );

  it.effect.prop(
    "adding another policy layer cannot increase capabilities",
    [names, FastCheck.array(filters, { maxLength: 4 }), filters],
    ([ambient, layers, additional]) =>
      Effect.sync(() => {
        const before = resolveCapabilitySet(ambient, layers);
        const after = resolveCapabilitySet(ambient, [...layers, additional]);

        assert.isTrue(after.every((name) => before.includes(name)));
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
      assert.deepStrictEqual(
        resolveCapabilitySet(
          ["read", "write", "bash", "agents"],
          [
            ["read", "write", "bash"],
            ["*", "!write", "+agents"],
          ],
        ),
        ["read", "bash"],
      );
      assert.deepStrictEqual(resolveCapabilitySet(["read", "write"], [["read"], []]), []);
      assert.deepStrictEqual(applyCapabilityFilter(["read", "write"], undefined), ["read", "write"]);
      assert.deepStrictEqual(applyCapabilityFilter(["read", "write"], ["read", "+write", "-read"]), ["write"]);
      assert.deepStrictEqual(applyCapabilityFilter(["write", "read"], ["read", "+write"]), ["write", "read"]);
    }),
  );
});
