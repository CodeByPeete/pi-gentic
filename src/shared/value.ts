import type { UnknownRecord } from "./types.js";

export function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function recordValue(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

export function recordArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function stringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return stringArray(value);
  const text = stringValue(value);

  return text
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function firstText(content: unknown) {
  return Array.isArray(content) ? content.find((item) => item?.type === "text")?.text : undefined;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function nonNegativeInteger(value: unknown, fieldName: string, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) throw new Error(`${fieldName} must be a non-negative number.`);
  return Math.floor(number);
}

export function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

export function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h:${minutes.toString().padStart(2, "0")}m:${seconds.toString().padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m:${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function omitUndefined<T extends UnknownRecord>(record: T): T {
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return record;
}

export function shortSessionId(sessionId: unknown) {
  return String(sessionId ?? "").slice(0, 8);
}

export function shortestUniqueSessionId(sessionId: unknown, sessionIds: unknown[] = []) {
  const full = String(sessionId ?? "");
  let length = Math.min(8, full.length);

  while (
    length < full.length &&
    sessionIds.some((candidate) => {
      const other = String(candidate ?? "");
      return other && other !== full && other.slice(0, length) === full.slice(0, length);
    })
  )
    length = Math.min(full.length, length + (full[length] === "-" ? 5 : 4));

  return full.slice(0, length);
}
