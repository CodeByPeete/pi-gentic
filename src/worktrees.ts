import type { PrepareWorktreeRequest } from "./application/WorktreeManager.js";
import {
  extensionRuntime,
  prepareWorktreeEffect,
} from "./runtime/ExtensionRuntime.js";

export type PrepareWorktreeOptions = PrepareWorktreeRequest;

export function prepareWorktree(
  options: PrepareWorktreeOptions,
): Promise<string> {
  return extensionRuntime.runPromise(prepareWorktreeEffect(options));
}
