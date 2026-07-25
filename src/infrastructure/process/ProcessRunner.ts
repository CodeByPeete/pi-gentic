import { Duration, Effect, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

export type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export const runProcess = Effect.fn("ProcessRunner.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly timeout?: Duration.Input } = {},
) {
  const process = ChildProcess.make(command, args, {
    cwd: options.cwd,
    forceKillAfter: "2 seconds",
  });
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
