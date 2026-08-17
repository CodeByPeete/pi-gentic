import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const absoluteHomePath =
  /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\r\n]+|\/(?:Users|home)\/[^/\r\n]+)/g;
const emailAddress = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const allowedEmailDomains = new Set(["example.com", "users.noreply.github.com"]);

function trackedTextFiles() {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);

  return files.flatMap((file) => {
    const absolutePath = path.join(root, file);
    if (!existsSync(absolutePath)) return [];
    const content = readFileSync(absolutePath);

    return content.includes(0) ? [] : [{ file, content: content.toString("utf8") }];
  });
}

test("tracked repository text excludes personal home paths and contact addresses", () => {
  const violations = trackedTextFiles().flatMap(({ file, content }) => {
    const paths = [...content.matchAll(absoluteHomePath)].map(([value]) => `${file}: personal path ${value}`);
    const emails = [...content.matchAll(emailAddress)]
      .map(([value]) => value)
      .filter((value) => !allowedEmailDomains.has(value.slice(value.lastIndexOf("@") + 1).toLowerCase()))
      .map((value) => `${file}: contact address ${value}`);

    return [...paths, ...emails];
  });

  assert.deepEqual(violations, []);
});
