import { existsSync, readFileSync } from "node:fs";
import type { UnknownRecord } from "../../shared/types.js";
import { errorMessage, isRecord } from "../../shared/value.js";

export function configurationDiagnostic(severity: string, filePath: string, message: string, error?: unknown) {
  return {
    severity,
    ...(filePath ? { path: filePath } : {}),
    message: error === undefined ? message : `${message}: ${errorMessage(error)}`,
  };
}

export function readJsonObject(filePath: string, diagnostics: UnknownRecord[], severity = "error") {
  if (!existsSync(filePath)) return undefined;

  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isRecord(value)) throw new Error("Expected a JSON object.");
    return value;
  } catch (error) {
    diagnostics.push(configurationDiagnostic(severity, filePath, "Could not parse JSON", error));
    return undefined;
  }
}
