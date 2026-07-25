import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Context, Effect, Layer, Metric, Redacted, Stream } from "effect";
import { GitCommandFailed } from "../../domain/errors.js";

const gitCommands = Metric.counter("pi_gentic_git_commands", { incremental: true });
const gitDuration = Metric.timer("pi_gentic_git_duration");

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

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
          const command = ChildProcess.make("git", args, {
            cwd,
            forceKillAfter: "2 seconds",
          });
          const operation = Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* command.pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              );
              const [stdout, stderr, exitCode] = yield* Effect.all(
                [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
                { concurrency: "unbounded" },
              );

              return {
                exitCode: Number(exitCode),
                stdout: decodeBytes(stdout).trim(),
                stderr: decodeBytes(stderr).trim(),
              };
            }),
          ).pipe(Effect.timeout("30 seconds"));

          yield* Metric.update(gitCommands, 1);
          const [duration, result] = yield* operation.pipe(
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

function decodeBytes(chunks: Iterable<Uint8Array>): string {
  let length = 0;

  for (const chunk of chunks) length += chunk.length;
  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(bytes);
}
