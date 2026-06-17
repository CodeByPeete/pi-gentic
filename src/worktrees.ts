/**
 * Git worktree preparation for delegated agent sessions.
 *
 * The agents tool treats cwd as the worktree folder when worktree is set.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function prepareWorktree({
  repoCwd,
  cwd,
  worktree,
  message,
}: AnyRecord) {
  const repoRoot = await gitOutput(String(repoCwd), [
    "rev-parse",
    "--show-toplevel",
  ]);
  const branchInput = stringOrUndefined(worktree);
  const fallbackName = worktreeSlug(
    branchInput ?? stringOrUndefined(cwd) ?? stringOrUndefined(message),
  );
  const worktreePath = path.resolve(
    repoRoot,
    cwd
      ? String(cwd)
      : path.join(".agentfiles", "worktrees", fallbackName),
  );
  const branch = gitBranchName(
    branchInput ?? path.basename(worktreePath) ?? fallbackName,
  );

  await ensureGitWorktree(repoRoot, worktreePath, branch);

  return worktreePath;
}

async function ensureGitWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
) {
  if (existsSync(path.join(worktreePath, ".git"))) return;

  try {
    await gitOutput(repoRoot, ["worktree", "add", worktreePath, branch]);
  } catch {
    await gitOutput(repoRoot, [
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      "HEAD",
    ]);
  }
}

async function gitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 30_000,
    windowsHide: true,
  });

  return stdout.trim();
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function worktreeSlug(value: unknown) {
  const source = String(value ?? "agent-worktree");
  const base = source
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return `${base || "agent-worktree"}-${hashText(source)}`;
}

function gitBranchName(value: unknown) {
  return (
    String(value ?? "agent-worktree")
      .replace(/\\/g, "/")
      .split("/")
      .map((part) =>
        part
          .replace(/[^A-Za-z0-9._-]+/g, "-")
          .replace(/^[-.]+|[-.]+$/g, ""),
      )
      .filter(Boolean)
      .join("/") || "agent-worktree"
  );
}

function hashText(value: string) {
  let hash = 5381;

  for (const char of value) hash = ((hash << 5) + hash) ^ char.charCodeAt(0);

  return Math.abs(hash >>> 0).toString(36).slice(0, 6);
}
