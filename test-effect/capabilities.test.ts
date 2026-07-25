import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { FastCheck } from "effect/testing";
import { applyCapabilityFilter, resolveCapabilitySet } from "../src/domain/capabilities.js";

const names = FastCheck.uniqueArray(FastCheck.stringMatching(/^[a-z][a-z0-9_-]{0,12}$/), { maxLength: 20 });
const filters = FastCheck.array(
  FastCheck.tuple(FastCheck.constantFrom("", "+", "-", "!"), FastCheck.stringMatching(/^[a-z][a-z0-9_*?-]{0,12}$/)).map(
    ([prefix, name]) => `${prefix}${name}`,
  ),
  { maxLength: 20 },
);

describe("CapabilitySet", () => {
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
