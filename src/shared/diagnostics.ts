export type DiagnosticSeverity = "debug" | "warning" | "error";

type RuntimeDiagnostic = {
  readonly scope: string;
  readonly message: string;
  readonly severity: DiagnosticSeverity;
  readonly timestamp: number;
};

const MAX_DIAGNOSTICS = 200;
const runtimeDiagnostics: RuntimeDiagnostic[] = [];

export function reportRuntimeDiagnostic(scope: string, error: unknown, severity: DiagnosticSeverity = "debug") {
  runtimeDiagnostics.push({
    scope,
    message: error instanceof Error ? error.message : String(error),
    severity,
    timestamp: Date.now(),
  });

  if (runtimeDiagnostics.length > MAX_DIAGNOSTICS)
    runtimeDiagnostics.splice(0, runtimeDiagnostics.length - MAX_DIAGNOSTICS);
}

export function recoverDiagnostic<T>(
  scope: string,
  operation: () => T,
  recover: (error: unknown) => T,
  severity: DiagnosticSeverity = "debug",
) {
  try {
    return operation();
  } catch (error) {
    reportRuntimeDiagnostic(scope, error, severity);
    return recover(error);
  }
}

export function readRuntimeDiagnostics(minimumSeverity: DiagnosticSeverity = "debug") {
  const severityRank: Record<DiagnosticSeverity, number> = {
    debug: 0,
    warning: 1,
    error: 2,
  };
  const minimumRank = severityRank[minimumSeverity];

  return runtimeDiagnostics.filter((diagnostic) => severityRank[diagnostic.severity] >= minimumRank);
}
