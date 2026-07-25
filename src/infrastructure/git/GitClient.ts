import { Context, Effect, Layer, Metric, Redacted } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GitCommandFailed } from "../../domain/errors.js";
import { runProcess, type ProcessResult } from "../process/ProcessRunner.js";

const gitCommands = Metric.counter("pi_gentic_git_commands", { incremental: true });
const gitDuration = Metric.timer("pi_gentic_git_duration");

export type GitResult = ProcessResult;

export class GitClient extends Context.Service<
  GitClient,
  {
    readonly run: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<GitResult, GitCommandFailed>;
  }
>()("pi-gentic/GitClient") {
  static readonly layer = Layer.effect(
    GitClient,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      return {
        run: Effect.fn("GitClient.run")(function* (cwd: string, args: ReadonlyArray<string>) {
          yield* Metric.update(gitCommands, 1);
          const [duration, result] = yield* runProcess("git", args, { cwd, timeout: "30 seconds" }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.withSpan("GitClient.run", {
              attributes: { args: args.join(" "), cwd: Redacted.make(cwd) },
            }),
            Effect.tapError((cause) => Effect.logDebug("Git command failed", cause)),
            Effect.mapError((cause) =>
              GitCommandFailed.make({
                message: `Git command failed: git ${args.join(" ")}`,
                cwd,
                args: [...args],
                cause,
              }),
            ),
            Effect.timed,
          );
          yield* Metric.update(gitDuration, duration);
          return result;
        }),
      };
    }),
  );
}
