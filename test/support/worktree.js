import { createExtensionRuntime, prepareWorktreeEffect } from "../../dist/extension-runtime.js";

export function prepareWorktree(request) {
  const runtime = createExtensionRuntime();

  return runtime.runPromise(prepareWorktreeEffect(request)).finally(() => runtime.dispose());
}
