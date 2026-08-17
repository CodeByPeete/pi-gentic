import { setTimeout as delay } from "node:timers/promises";
import { Effect, ManagedRuntime } from "effect";
import { WorktreeManager, type PrepareWorktreeRequest } from "../application/WorktreeManager.js";
import { AppLayer } from "./AppLayer.js";

export function shouldDisposeExtensionRuntime(reason: "quit" | "reload" | "new" | "resume" | "fork") {
  return reason === "quit" || reason === "reload";
}

export function createExtensionRuntime() {
  const runtime = ManagedRuntime.make(AppLayer);
  const disposeManaged = runtime.dispose.bind(runtime);
  let leases = 0;
  let disposalRequested = false;
  let disposalStarted = false;
  let disposalVersion = 0;
  const { promise: disposal, resolve: resolveDisposal, reject: rejectDisposal } = Promise.withResolvers<void>();
  const dispose = () => {
    disposalVersion += 1;
    if (disposalStarted) return disposal;
    disposalStarted = true;
    void disposeManaged().then(resolveDisposal, rejectDisposal);

    return disposal;
  };
  const scheduleIdleDisposal = () => {
    if (!disposalRequested || disposalStarted || leases > 0) return;
    const version = ++disposalVersion;

    // Let the retained operation's Effect fiber finish its own finalizers before closing the runtime scope.
    void delay(0, undefined, { ref: false }).then(() => {
      if (version === disposalVersion && leases === 0) void dispose();
    });
  };
  const retain = () => {
    if (disposalStarted) throw new Error("Cannot retain a disposed extension runtime.");
    disposalVersion += 1;
    leases += 1;
    let released = false;

    return () => {
      if (released) return;
      released = true;
      leases -= 1;
      scheduleIdleDisposal();
    };
  };
  const disposeWhenIdle = () => {
    disposalRequested = true;
    scheduleIdleDisposal();

    return disposal;
  };

  return Object.assign(runtime, { dispose, disposeWhenIdle, retain });
}

export type ExtensionRuntime = ReturnType<typeof createExtensionRuntime>;

export const prepareWorktreeEffect = Effect.fn("ExtensionRuntime.prepareWorktree")(function* (
  request: PrepareWorktreeRequest,
) {
  const worktrees = yield* WorktreeManager;

  return yield* worktrees.prepare(request);
});
