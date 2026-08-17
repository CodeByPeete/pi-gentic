import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const domainDirectory = path.resolve("src/domain");

async function domainSourceFiles() {
  return (await readdir(domainDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(domainDirectory, entry.name));
}

test("domain rules do not depend on outer application layers", async () => {
  const forbiddenImports = [];

  for (const file of await domainSourceFiles()) {
    const source = await readFile(file, "utf8");

    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const specifier = match[1];

      if (specifier?.startsWith("../") && !specifier.startsWith("../shared/")) {
        forbiddenImports.push(`${path.basename(file)} -> ${specifier}`);
      }
    }
  }

  assert.deepEqual(forbiddenImports, []);
});
