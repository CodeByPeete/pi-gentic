import { Effect, ManagedRuntime } from "effect";
import { WorktreeManager, type PrepareWorktreeRequest } from "../application/WorktreeManager.js";
import { AppLayer } from "./AppLayer.js";

export function shouldDisposeExtensionRuntime(reason: "quit" | "reload" | "new" | "resume" | "fork") {
  return reason === "quit" || reason === "reload";
}

export function createExtensionRuntime() {
  return ManagedRuntime.make(AppLayer);
}

export type ExtensionRuntime = ReturnType<typeof createExtensionRuntime>;

export const prepareWorktreeEffect = Effect.fn("ExtensionRuntime.prepareWorktree")(function* (
  request: PrepareWorktreeRequest,
) {
  const worktrees = yield* WorktreeManager;

  return yield* worktrees.prepare(request);
});
