import { Effect, FileSystem, Layer, Path, Semaphore } from "effect";
import { WorktreeManager, type PrepareWorktreeRequest } from "../../application/WorktreeManager.js";
import {
  GitCommandFailed,
  PathOutsideAllowedRoot,
  WorktreePathConflict,
  WorktreeRepositoryInvalid,
} from "../../domain/errors.js";
import { GitClient } from "./GitClient.js";

export const WorktreeManagerLive = Layer.effect(
  WorktreeManager,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitClient;
    const repositoryLocks = new Map<string, Semaphore.Semaphore>();

    const pathFailure = (message: string, worktreePath: string, cause: unknown) =>
      WorktreePathConflict.make({
        message,
        worktreePath,
        cause,
      });

    const gitResult = Effect.fn("WorktreeManager.gitResult")(function* (cwd: string, args: ReadonlyArray<string>) {
      return yield* git.run(cwd, args);
    });

    const requireGitSuccess = Effect.fn("WorktreeManager.requireGitSuccess")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
    ) {
      const result = yield* gitResult(cwd, args);

      if (result.exitCode !== 0) {
        return yield* GitCommandFailed.make({
          message: result.stderr || `Git command failed with exit code ${result.exitCode}: git ${args.join(" ")}`,
          cwd,
          args: [...args],
          exitCode: result.exitCode,
          stderr: result.stderr,
        });
      }

      return result;
    });

    const repositoryRoot = Effect.fn("WorktreeManager.repositoryRoot")(function* (repoCwd: unknown, repo: unknown) {
      const base = nonEmptyString(repoCwd) ?? process.cwd();
      const source = nonEmptyString(repo);
      const repositoryPath = source ? path.resolve(base, source) : path.resolve(base);
      const result = yield* gitResult(repositoryPath, ["rev-parse", "--show-toplevel"]).pipe(
        Effect.catchTag("GitCommandFailed", (cause) =>
          WorktreeRepositoryInvalid.make({
            message: `Worktree repository must be a git repository: ${repositoryPath}`,
            repositoryPath,
            cause,
          }),
        ),
      );

      if (result.exitCode !== 0 || result.stdout.length === 0) {
        return yield* WorktreeRepositoryInvalid.make({
          message: `Worktree repository must be a git repository: ${repositoryPath}`,
          repositoryPath,
          cause: result.stderr,
        });
      }

      const resolvePath = (candidate: string) =>
        fileSystem.realPath(candidate).pipe(
          Effect.mapError((cause) =>
            WorktreeRepositoryInvalid.make({
              message: `Worktree repository must be a git repository: ${repositoryPath}`,
              repositoryPath,
              cause,
            }),
          ),
        );
      const canonicalRepositoryPath = yield* resolvePath(repositoryPath);
      const canonicalRoot = yield* resolvePath(path.resolve(result.stdout));

      return path.resolve(repositoryPath, path.relative(canonicalRepositoryPath, canonicalRoot));
    });

    const canonicalCandidate = Effect.fn("WorktreeManager.canonicalCandidate")(function* (
      candidate: string,
      allowedRoots: ReadonlyArray<string>,
    ) {
      const canonicalRoots = yield* Effect.forEach(
        allowedRoots,
        (root) =>
          fileSystem
            .realPath(root)
            .pipe(
              Effect.mapError((cause) =>
                pathFailure(`Cannot resolve allowed worktree root: ${root}`, candidate, cause),
              ),
            ),
        { concurrency: "unbounded" },
      );
      let ancestor = candidate;

      while (
        !(yield* fileSystem
          .exists(ancestor)
          .pipe(Effect.mapError((cause) => pathFailure(`Cannot inspect worktree path: ${ancestor}`, candidate, cause))))
      ) {
        const parent = path.dirname(ancestor);

        if (parent === ancestor) {
          return yield* PathOutsideAllowedRoot.make({
            message: `Worktree path is outside the allowed worktree root: ${candidate}`,
            path: candidate,
            allowedRoots: [...allowedRoots],
          });
        }
        ancestor = parent;
      }

      const canonicalAncestor = yield* fileSystem
        .realPath(ancestor)
        .pipe(Effect.mapError((cause) => pathFailure(`Cannot resolve worktree path: ${ancestor}`, candidate, cause)));
      const projected = path.resolve(canonicalAncestor, path.relative(ancestor, candidate));

      if (!canonicalRoots.some((root) => isDescendant(path, root, projected))) {
        return yield* PathOutsideAllowedRoot.make({
          message: `Worktree path is outside the allowed worktree root: ${candidate}`,
          path: candidate,
          allowedRoots: [...canonicalRoots],
        });
      }

      return projected;
    });

    const registeredWorktrees = Effect.fn("WorktreeManager.registeredWorktrees")(function* (repoRoot: string) {
      const result = yield* requireGitSuccess(repoRoot, ["worktree", "list", "--porcelain", "-z"]);

      return result.stdout
        .split("\0")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => path.resolve(line.slice("worktree ".length)));
    });

    const prepare = Effect.fn("WorktreeManager.prepare")(function* (request: PrepareWorktreeRequest) {
      const repoRoot = yield* repositoryRoot(request.repoCwd, request.repo);
      const worktreeRoot = path.join(repoRoot, ".agentfiles", "worktrees");
      const branchInput = nonEmptyString(request.worktree);
      const explicitCwd = nonEmptyString(request.cwd);
      const fallbackName = worktreeSlug(branchInput ?? explicitCwd ?? nonEmptyString(request.message));
      const worktreePath = explicitCwd ? path.resolve(repoRoot, explicitCwd) : path.join(worktreeRoot, fallbackName);
      const configuredRoots = (request.allowedWorktreeRoots ?? [])
        .map(nonEmptyString)
        .filter((root): root is string => root !== undefined)
        .map((root) => path.resolve(repoRoot, root));
      const allowedRoots = explicitCwd ? [repoRoot, ...configuredRoots] : [worktreeRoot];
      const gitMetadata = path.join(repoRoot, ".git");

      if (
        !allowedRoots.some((root) => isDescendant(path, root, worktreePath)) ||
        isSamePath(path, repoRoot, worktreePath) ||
        isSamePath(path, gitMetadata, worktreePath) ||
        isDescendant(path, gitMetadata, worktreePath)
      ) {
        return yield* PathOutsideAllowedRoot.make({
          message: `Worktree path is outside the allowed worktree root: ${worktreePath}`,
          path: worktreePath,
          allowedRoots,
        });
      }

      if (!explicitCwd) {
        yield* fileSystem
          .makeDirectory(worktreeRoot, { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              pathFailure(`Cannot create worktree root: ${worktreeRoot}`, worktreePath, cause),
            ),
          );
      }

      yield* canonicalCandidate(worktreePath, allowedRoots);
      const lock = repositoryLocks.get(repoRoot) ?? Semaphore.makeUnsafe(1);
      repositoryLocks.set(repoRoot, lock);

      return yield* lock.withPermit(
        Effect.gen(function* () {
          const existing = yield* fileSystem
            .exists(worktreePath)
            .pipe(
              Effect.mapError((cause) =>
                pathFailure(`Cannot inspect worktree path: ${worktreePath}`, worktreePath, cause),
              ),
            );
          const registered = yield* registeredWorktrees(repoRoot);

          if (existing) {
            if (registered.some((entry) => isSamePath(path, entry, worktreePath))) {
              yield* canonicalCandidate(worktreePath, allowedRoots);
              return worktreePath;
            }

            return yield* WorktreePathConflict.make({
              message: `Worktree path belongs to an unrelated or unregistered repository: ${worktreePath}`,
              worktreePath,
            });
          }

          const branch = branchInput ?? gitBranchName(path.basename(worktreePath) || fallbackName);
          const branchCheck = yield* gitResult(repoRoot, ["check-ref-format", "--branch", branch]);

          if (branchCheck.exitCode !== 0) {
            return yield* WorktreePathConflict.make({
              message: `Invalid Git branch name for worktree: ${branch}`,
              worktreePath,
              cause: branchCheck.stderr,
            });
          }

          const branchLookup = yield* gitResult(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
          const addArgs =
            branchLookup.exitCode === 0
              ? ["worktree", "add", worktreePath, branch]
              : ["worktree", "add", "-b", branch, worktreePath, "HEAD"];
          yield* requireGitSuccess(repoRoot, addArgs);
          yield* canonicalCandidate(worktreePath, allowedRoots);
          const after = yield* registeredWorktrees(repoRoot);

          if (!after.some((entry) => isSamePath(path, entry, worktreePath))) {
            return yield* WorktreePathConflict.make({
              message: `Created path is not a registered worktree of the expected repository: ${worktreePath}`,
              worktreePath,
            });
          }

          return worktreePath;
        }),
      );
    });

    return { prepare };
  }),
);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function worktreeSlug(value: unknown): string {
  const source = String(value ?? "agent-worktree").normalize("NFKC");
  const base = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");

  return `${base || "agent-worktree"}-${hashText(source)}`;
}

function gitBranchName(value: string): string {
  const branch = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  return branch || "agent-worktree";
}

function hashText(value: string): string {
  let hash = 5381;

  for (const char of value) hash = ((hash << 5) + hash) ^ char.charCodeAt(0);

  return (hash >>> 0).toString(36).slice(0, 6);
}

function isDescendant(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return (
    relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function isSamePath(path: Path.Path, left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.normalize(path.resolve(value));

    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };

  return normalize(left) === normalize(right);
}
