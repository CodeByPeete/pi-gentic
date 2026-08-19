import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { WorktreeManager } from "../../dist/worktrees/manager.js";
import { GitClient } from "../../dist/worktrees/git.js";
import { WorktreeManagerLive } from "../../dist/worktrees/manager.js";

const result = (stdout = "", exitCode = 0, stderr = "") => ({
  stdout,
  stderr,
  exitCode,
});

function prepareWith(run, request) {
  const dependencies = Layer.succeed(GitClient, { run }).pipe(Layer.provideMerge(NodeServices.layer));
  const layer = WorktreeManagerLive.pipe(Layer.provide(dependencies));

  return Effect.runPromise(
    Effect.flatMap(WorktreeManager, (worktrees) => worktrees.prepare(request)).pipe(Effect.provide(layer)),
  );
}

test("Effect worktree manager preserves typed Git and registration failures", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "pi-gentic-effect-git-"));

  await assert.rejects(
    () =>
      prepareWith(() => Effect.succeed(result("", 1, "not a repository")), {
        repoCwd: repo,
        message: "invalid repository",
      }),
    /Worktree repository must be a git repository/,
  );

  await assert.rejects(
    () =>
      prepareWith(() => Effect.succeed(result(path.join(repo, "missing-repository-root"))), {
        repoCwd: repo,
        message: "missing canonical repository",
      }),
    /Worktree repository must be a git repository/,
  );

  await assert.rejects(
    () =>
      prepareWith(
        (_cwd, args) => {
          if (args[0] === "rev-parse") return Effect.succeed(result(repo));
          return Effect.succeed(result());
        },
        {
          repoCwd: repo,
          cwd: "missing-root/worktree",
          allowedWorktreeRoots: ["missing-root"],
          message: "missing allowed root",
        },
      ),
    /Cannot resolve allowed worktree root/,
  );

  await assert.rejects(
    () =>
      prepareWith(
        (_cwd, args) => {
          if (args[0] === "rev-parse") return Effect.succeed(result(repo));
          if (args[0] === "worktree" && args[1] === "list") return Effect.succeed(result(""));
          if (args[0] === "check-ref-format") return Effect.succeed(result("", 0));
          if (args[0] === "show-ref") return Effect.succeed(result("", 1));
          return Effect.succeed(result("", 1, "cannot add worktree"));
        },
        { repoCwd: repo, message: "failed add" },
      ),
    /cannot add worktree/,
  );

  await assert.rejects(
    () =>
      prepareWith(
        (_cwd, args) => {
          if (args[0] === "rev-parse") return Effect.succeed(result(repo));
          if (args[0] === "worktree" && args[1] === "list") return Effect.succeed(result(""));
          if (args[0] === "check-ref-format") return Effect.succeed(result("", 0));
          if (args[0] === "show-ref") return Effect.succeed(result("", 1));
          return Effect.succeed(result());
        },
        { repoCwd: repo, message: "unregistered result" },
      ),
    /not a registered worktree/,
  );
});
