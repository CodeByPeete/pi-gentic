import { Context, Duration, Effect, Layer, Metric, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class GitCommandFailed extends Schema.TaggedErrorClass<GitCommandFailed>()("GitCommandFailed", {
  message: Schema.String,
  cwd: Schema.String,
  args: Schema.Array(Schema.String),
  exitCode: Schema.optionalKey(Schema.Finite),
  stderr: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const gitCommands = Metric.counter("pi_gentic_git_commands", { incremental: true });
const gitDuration = Metric.timer("pi_gentic_git_duration");

export type GitResult = ProcessResult;

export const runProcess = Effect.fn("ProcessRunner.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly timeout?: Duration.Input } = {},
) {
  const process = ChildProcess.make(command, args, { cwd: options.cwd, forceKillAfter: "2 seconds" });
  const result = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* process;
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          ),
          handle.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          ),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: Number(exitCode),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      } satisfies ProcessResult;
    }),
  );
  return yield* options.timeout ? result.pipe(Effect.timeout(options.timeout)) : result;
});

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
