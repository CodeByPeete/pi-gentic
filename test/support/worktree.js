import { createExtensionRuntime, prepareWorktreeEffect } from "../../dist/runtime/ExtensionRuntime.js";

export function prepareWorktree(request) {
  const runtime = createExtensionRuntime();

  return runtime.runPromise(prepareWorktreeEffect(request)).finally(() => runtime.dispose());
}
