import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { FastCheck } from "effect/testing";
import {
  applyCapabilityFilter,
  reconcileActiveToolSelection,
  resolveActiveToolSelection,
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
  it.effect("adopts the first observed active selection as ambient", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        reconcileActiveToolSelection({
          registeredToolNames: ["read", "exec_command", "agents"],
          observedToolNames: ["exec_command", "agents"],
          filters: ["*"],
        }),
        {
          selection: ["exec_command", "agents"],
          changed: false,
          state: {
            ambientToolNames: ["exec_command", "agents"],
            appliedToolNames: ["exec_command", "agents"],
          },
        },
      );
    }),
  );

  it.effect("restores ambient tools when an explicit restriction is released", () =>
    Effect.sync(() => {
      const restricted = reconcileActiveToolSelection({
        registeredToolNames: ["read", "exec_command", "agents"],
        observedToolNames: ["exec_command", "agents"],
        filters: ["agents"],
      });
      const released = reconcileActiveToolSelection({
        registeredToolNames: ["read", "exec_command", "agents"],
        observedToolNames: restricted.selection,
        filters: ["*"],
        previousState: restricted.state,
      });

      assert.deepStrictEqual(restricted.selection, ["agents"]);
      assert.deepStrictEqual(released.selection, ["exec_command", "agents"]);
    }),
  );

  it.effect("adopts a newer complete observed selection as ambient", () =>
    Effect.sync(() => {
      const reconciliation = reconcileActiveToolSelection({
        registeredToolNames: ["read", "exec_command", "view_image", "agents"],
        observedToolNames: ["view_image", "agents"],
        filters: ["*"],
        previousState: {
          ambientToolNames: ["exec_command", "agents"],
          appliedToolNames: ["agents"],
        },
      });

      assert.deepStrictEqual(reconciliation, {
        selection: ["view_image", "agents"],
        changed: false,
        state: {
          ambientToolNames: ["view_image", "agents"],
          appliedToolNames: ["view_image", "agents"],
        },
      });
    }),
  );

  it.effect("drops unavailable tools from remembered policy state", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        reconcileActiveToolSelection({
          registeredToolNames: ["agents"],
          observedToolNames: ["agents"],
          filters: ["*"],
          previousState: {
            ambientToolNames: ["exec_command", "agents"],
            appliedToolNames: ["agents"],
          },
        }),
        {
          selection: ["agents"],
          changed: false,
          state: { ambientToolNames: ["agents"], appliedToolNames: ["agents"] },
        },
      );
    }),
  );

  it.effect("preserves an ambient adapter tool surface for wildcard policy", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        resolveActiveToolSelection({
          registeredToolNames: ["read", "bash", "exec_command", "apply_patch", "agents"],
          ambientToolNames: ["exec_command", "apply_patch", "agents"],
          filters: ["*"],
        }),
        ["exec_command", "apply_patch", "agents"],
      );
    }),
  );

  it.effect("subtracts exclusion-only policy from the ambient tool selection", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        resolveActiveToolSelection({
          registeredToolNames: ["read", "write", "agents"],
          ambientToolNames: ["write", "agents"],
          filters: ["!write"],
        }),
        ["agents"],
      );
    }),
  );

  it.effect("applies exact additions before exact removals", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        resolveActiveToolSelection({
          registeredToolNames: ["read", "write", "agents", "view_image"],
          ambientToolNames: ["agents"],
          filters: ["*", "+VIEW_IMAGE", "+write", "-view_image"],
        }),
        ["agents", "write"],
      );
    }),
  );

  it.effect("selects plain patterns explicitly in registered catalog order", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        resolveActiveToolSelection({
          registeredToolNames: ["write", "read_file", "read", "agents"],
          ambientToolNames: ["agents", "write"],
          filters: ["read*", "+agents"],
        }),
        ["read_file", "read", "agents"],
      );
    }),
  );

  it.effect("selects no tools for an empty filter list", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        resolveActiveToolSelection({
          registeredToolNames: ["read", "agents"],
          ambientToolNames: ["agents"],
          filters: [],
        }),
        [],
      );
    }),
  );

  it.effect("ignores unknown and duplicate tool names", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        resolveActiveToolSelection({
          registeredToolNames: ["read", "agents"],
          ambientToolNames: ["agents", "missing", "agents"],
          filters: ["*", "+missing", "+read", "+READ"],
        }),
        ["agents", "read"],
      );
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
    }),
  );
});
