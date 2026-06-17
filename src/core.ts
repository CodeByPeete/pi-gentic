/**
 * Small shared primitives with no Pi runtime dependency.
 *
 * These helpers are safe to reuse from policy, prompt, session, and run code.
 */

const FILTER_ALL = ["*"];

export function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toStringArray(value) {
  if (Array.isArray(value))
    return value.filter((item) => typeof item === "string");

  if (typeof value === "string")
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  return undefined;
}

export function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function parseIntegerRadius(value, fieldName, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(number) || number < 0)
    throw new Error(`${fieldName} must be a non-negative number.`);
  return Math.floor(number);
}

export function chooseBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0)
    return `${hours}h:${minutes.toString().padStart(2, "0")}m:${seconds.toString().padStart(2, "0")}s`;

  if (minutes > 0) return `${minutes}m:${seconds.toString().padStart(2, "0")}s`;

  return `${seconds}s`;
}

function wildcardToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(name, pattern) {
  if (pattern === "*") return true;

  if (pattern.includes("*") || pattern.includes("?"))
    return wildcardToRegExp(pattern).test(name);
  return name.toLowerCase().includes(pattern.toLowerCase());
}

/** Resolves Pi-style include and exclude filters into a stable ordered list. */
export function applyFilterList(allNames: string[], filters = FILTER_ALL) {
  if (!Array.isArray(filters)) return [...allNames];

  if (filters.length === 0) return [];
  const includes: string[] = [];
  const excludes: string[] = [];
  const forceIncludes: string[] = [];
  const forceExcludes: string[] = [];

  for (const raw of filters) {
    if (typeof raw !== "string" || !raw) continue;

    if (raw.startsWith("+")) forceIncludes.push(raw.slice(1));
    else if (raw.startsWith("-")) forceExcludes.push(raw.slice(1));
    else if (raw.startsWith("!")) excludes.push(raw.slice(1));
    else includes.push(raw);
  }

  const selected = new Set(
    includes.length === 0
      ? allNames
      : allNames.filter((name) =>
          includes.some((p) => matchesPattern(name, p)),
        ),
  );

  for (const name of [...selected]) {
    if (excludes.some((p) => matchesPattern(name, p))) selected.delete(name);
  }

  for (const name of allNames) {
    if (forceIncludes.some((p) => p.toLowerCase() === name.toLowerCase()))
      selected.add(name);
  }

  for (const name of allNames) {
    if (forceExcludes.some((p) => p.toLowerCase() === name.toLowerCase()))
      selected.delete(name);
  }

  return allNames.filter((name) => selected.has(name));
}

export function mergeFilterLayers(...layers: unknown[]) {
  const result: string[] = [];

  for (const layer of layers) {
    if (layer === undefined) continue;

    if (!Array.isArray(layer)) continue;

    if (layer.length === 0) return [];
    result.push(...layer);
  }

  return result.length === 0 ? undefined : result;
}

export function coalesce(value, fallback) {
  return value === undefined ? fallback : value;
}

export function shortSessionId(sessionId) {
  return String(sessionId ?? "").slice(0, 8);
}

/** Creates the message visible to a target session when another session contacts it. */
export function buildReceiptText(callerAgent, callerSessionId, message) {
  const agentText = callerAgent ? `[${callerAgent}] agent` : "agent";

  return `Message from ${agentText} from session ${shortSessionId(callerSessionId)}:\n${message}\nOnly your final answer will be returned.`;
}

export function buildReturnText(agent, sessionId, finalAnswer) {
  const agentText = agent ? `[${agent}] agent` : "agent";

  return `Message from ${agentText} from session ${shortSessionId(sessionId)}:\n${finalAnswer}`;
}
