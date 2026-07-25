import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareWorktree } from "../dist/worktrees.js";

function createRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-gentic-worktree-security-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(path.join(repo, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], {
    cwd: repo,
    stdio: "ignore",
  });

  return {
    repo,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

test("message-derived worktrees stay inside the repository worktree root", async () => {
  const fixture = createRepository();

  try {
    const result = await prepareWorktree({
      repoCwd: fixture.repo,
      message: "../escaped-audit",
    });
    const expectedRoot = path.join(fixture.repo, ".agentfiles", "worktrees");

    assert.equal(isWithin(expectedRoot, result), true);
  } finally {
    fixture.cleanup();
  }
});

test("explicit cwd outside an allowed worktree root is rejected", async () => {
  const fixture = createRepository();

  try {
    await assert.rejects(
      prepareWorktree({ repoCwd: fixture.repo, cwd: "../outside" }),
      /outside (?:the )?allowed worktree root/i,
    );
  } finally {
    fixture.cleanup();
  }
});

test("an unrelated git directory is not accepted as an existing worktree", async () => {
  const fixture = createRepository();
  const unrelated = path.join(fixture.repo, ".agentfiles", "worktrees", "occupied");

  try {
    mkdirSync(unrelated, { recursive: true });
    execFileSync("git", ["init"], { cwd: unrelated, stdio: "ignore" });

    await assert.rejects(
      prepareWorktree({
        repoCwd: fixture.repo,
        cwd: unrelated,
        worktree: "occupied",
      }),
      /expected repository|unrelated|registered worktree/i,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a junction cannot redirect worktree creation outside the allowed root", async (context) => {
  const fixture = createRepository();
  const worktreeRoot = path.join(fixture.repo, ".agentfiles", "worktrees");
  const outside = path.join(fixture.root, "outside");
  const junction = path.join(worktreeRoot, "redirect");

  try {
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(outside);
    try {
      symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`junction creation unavailable: ${String(error)}`);
      return;
    }

    await assert.rejects(
      prepareWorktree({
        repoCwd: fixture.repo,
        cwd: path.join(junction, "child"),
        worktree: "redirect-child",
      }),
      /outside (?:the )?allowed worktree root|symbolic link|junction/i,
    );
  } finally {
    fixture.cleanup();
  }
});
