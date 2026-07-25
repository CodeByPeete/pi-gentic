import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRuntimeDiagnostics,
  readRuntimeDiagnostics,
  reportRuntimeDiagnostic,
} from "../dist/diagnostics.js";

test("runtime diagnostics retain structured severity and normalize unknown errors", () => {
  clearRuntimeDiagnostics();
  reportRuntimeDiagnostic("default", new Error("debug failure"));
  reportRuntimeDiagnostic("warning", "warning failure", "warning");
  reportRuntimeDiagnostic("error", { reason: "failure" }, "error");

  assert.deepEqual(
    readRuntimeDiagnostics("warning").map(({ scope, message, severity }) => ({
      scope,
      message,
      severity,
    })),
    [
      {
        scope: "warning",
        message: "warning failure",
        severity: "warning",
      },
      {
        scope: "error",
        message: "[object Object]",
        severity: "error",
      },
    ],
  );
});

test("runtime diagnostics keep a bounded recent history", () => {
  clearRuntimeDiagnostics();

  for (let index = 0; index < 205; index++)
    reportRuntimeDiagnostic("bounded", index);

  const diagnostics = readRuntimeDiagnostics();

  assert.equal(diagnostics.length, 200);
  assert.equal(diagnostics[0].message, "5");
  assert.equal(diagnostics.at(-1).message, "204");
});
