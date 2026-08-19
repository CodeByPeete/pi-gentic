import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const sourceRoot = path.resolve("src");
const allowedFolders = new Set(["agents", "delegation", "pi", "sessions", "shared", "ui", "worktrees"]);
const allowedRootFiles = new Set(["extension.ts", "extension-runtime.ts", "settings.ts"]);

async function sourceFiles() {
  return (await readdir(sourceRoot, { recursive: true }))
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(sourceRoot, entry));
}

function sourceImports(source) {
  return [...source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)].map((match) => match[1]);
}

function relativeSource(file, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  return path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"));
}

test("source folders and imports expose one cycle-free feature architecture", async () => {
  const files = await sourceFiles();
  const known = new Set(files);
  const graph = new Map(files.map((file) => [file, []]));
  const unresolved = [];

  for (const file of files) {
    const relative = path.relative(sourceRoot, file);
    const [folder] = relative.split(path.sep);
    assert.equal(
      relative.includes(path.sep) ? allowedFolders.has(folder) : allowedRootFiles.has(relative),
      true,
      `Unexpected source location: ${relative}`,
    );
    assert.notEqual(path.basename(file), "index.ts", `Forwarding index files are forbidden: ${relative}`);
    const source = await readFile(file, "utf8");

    if (source.includes("/modes/") || source.includes("/core/"))
      assert.equal(relative, path.join("pi", "runtime.ts"), `Private Pi path outside pi/runtime.ts: ${relative}`);

    for (const specifier of sourceImports(source)) {
      const target = relativeSource(file, specifier);
      if (!target) continue;
      if (!known.has(target)) unresolved.push(`${relative} -> ${specifier}`);
      else graph.get(file).push(target);
    }
  }

  assert.deepEqual(unresolved, []);
  const active = new Set();
  const visited = new Set();
  const visit = (file) => {
    if (active.has(file)) throw new Error(`Circular source import at ${path.relative(sourceRoot, file)}`);
    if (visited.has(file)) return;
    active.add(file);
    for (const dependency of graph.get(file)) visit(dependency);
    active.delete(file);
    visited.add(file);
  };
  for (const file of files) visit(file);
});
