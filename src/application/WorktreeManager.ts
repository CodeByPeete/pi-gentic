import { Context, Effect } from "effect";
import type { WorktreeError } from "../domain/errors.js";

export interface PrepareWorktreeRequest {
  readonly repoCwd?: unknown;
  readonly repo?: unknown;
  readonly cwd?: unknown;
  readonly worktree?: unknown;
  readonly message?: unknown;
  readonly allowedWorktreeRoots?: ReadonlyArray<unknown>;
}

export class WorktreeManager extends Context.Service<
  WorktreeManager,
  {
    readonly prepare: (request: PrepareWorktreeRequest) => Effect.Effect<string, WorktreeError>;
  }
>()("pi-gentic/WorktreeManager") {}
