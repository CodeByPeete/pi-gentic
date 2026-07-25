import type { PrepareWorktreeRequest } from "./application/WorktreeManager.js";
import { createExtensionRuntime, prepareWorktreeEffect } from "./runtime/ExtensionRuntime.js";

export type PrepareWorktreeOptions = PrepareWorktreeRequest;

export async function prepareWorktree(options: PrepareWorktreeOptions) {
  const runtime = createExtensionRuntime();

  try {
    return await runtime.runPromise(prepareWorktreeEffect(options));
  } finally {
    await runtime.dispose();
  }
}
