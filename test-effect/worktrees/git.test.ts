import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { runProcess } from "../../src/worktrees/git.js";

it.layer(NodeServices.layer)((it) => {
  it.effect("collects scoped process output with a timeout", () =>
    runProcess(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"], {
      timeout: "5 seconds",
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toEqual({ exitCode: 0, stdout: "out", stderr: "err" });
        }),
      ),
    ),
  );

  it.effect("preserves nonzero process exits without a timeout", () =>
    runProcess(process.execPath, ["-e", "process.stdout.write(process.cwd()); process.exitCode = 7"], {
      cwd: process.cwd(),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.exitCode).toBe(7);
          expect(result.stdout).toBe(process.cwd());
          expect(result.stderr).toBe("");
        }),
      ),
    ),
  );
});
