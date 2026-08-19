import { Exit, Schema } from "effect";
import type { AgentDefinition } from "../../domain/configuration.js";
import type { PiSessionManager } from "../../infrastructure/pi/types.js";
import type { UnknownRecord } from "../../shared/types.js";
import { isRecord } from "../../shared/value.js";

const persistedStateDiagnostics = new Set<string>();

const ActiveStateSchema = Schema.Struct({
  agentName: Schema.optional(Schema.String.check(Schema.isPattern(/\S/))),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
});

export function getActiveState(sessionManager: PiSessionManager) {
  const entries = sessionManager.getEntries?.() ?? [];

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];

    if (isRecord(entry) && entry.type === "custom" && entry.customType === "pi-gentic:state") {
      const decoded = decodeActiveState(entry.data);

      if (decoded) return decoded;
      persistedStateDiagnostics.add("Ignored an invalid persisted active-agent state.");
    }
  }

  return emptyActiveState();
}

export function appendActiveState(sessionManager: PiSessionManager, state: unknown) {
  if (typeof sessionManager.appendCustomEntry !== "function")
    throw new Error("The active Pi session does not support custom state entries.");

  sessionManager.appendCustomEntry("pi-gentic:state", decodeActiveState(state) ?? {});
}

function decodeActiveState(value: unknown) {
  const decoded = Schema.decodeUnknownExit(ActiveStateSchema)(value);

  return Exit.isSuccess(decoded) ? decoded.value : undefined;
}

export function activeStateDiagnostics() {
  return [...persistedStateDiagnostics];
}

function emptyActiveState() {
  return { agentName: undefined, overrides: undefined };
}

export function subagentCreationError({
  currentDepth,
  maxSubagentDepth,
  globalMaxSubagentDepth,
}: {
  currentDepth: unknown;
  maxSubagentDepth: unknown;
  globalMaxSubagentDepth: unknown;
}) {
  const depth = Math.max(0, integer(currentDepth));
  const localLimit = integer(maxSubagentDepth);
  const globalLimit = integer(globalMaxSubagentDepth);
  const nextDepth = depth + 1;

  if (localLimit < 1)
    return new Error(
      `Cannot create a child session because maxSubagentDepth is ${localLimit}. Reuse an existing session or raise the local limit.`,
    );

  if (nextDepth > globalLimit)
    return new Error(
      `Cannot create a child session at depth ${nextDepth} because globalMaxSubagentDepth is ${globalLimit}. Reuse an existing session or raise the global limit.`,
    );

  return undefined;
}

export function assertCanCreateSubagent(limits: Parameters<typeof subagentCreationError>[0]) {
  const error = subagentCreationError(limits);
  if (error) throw error;
}

function integer(value: unknown) {
  const number = Number(value);

  return Number.isFinite(number) ? Math.floor(number) : 0;
}

export const AGENT_CYCLE_SHORTCUT = "f7";

export function nextAgentName(currentAgentName: string | undefined, agents: UnknownRecord[]) {
  const cycle = [undefined, ...agents.map((agent) => String(agent.name))];
  const index = cycle.findIndex((name) => name === currentAgentName);

  return cycle[index === -1 ? 1 : (index + 1) % cycle.length];
}

function hasPersistedAgentState(sessionManager: PiSessionManager) {
  return (sessionManager.getEntries?.() ?? []).some(
    (entry) => isRecord(entry) && entry.type === "custom" && entry.customType === "pi-gentic:state",
  );
}

export function shouldApplyDefaultAgent(event: { reason?: unknown }, sessionManager: PiSessionManager) {
  return (
    typeof event.reason === "string" &&
    ["new", "startup"].includes(event.reason) &&
    isBlankSession(sessionManager) &&
    !hasPersistedAgentState(sessionManager)
  );
}

function isBlankSession(sessionManager: PiSessionManager) {
  return !(sessionManager.getEntries?.() ?? []).some(
    (entry) => isRecord(entry) && (entry.type === "message" || entry.type === "custom_message"),
  );
}

export function configuredDefaultAgent(settings: UnknownRecord) {
  return typeof settings?.defaultAgent === "string" && settings.defaultAgent.trim()
    ? settings.defaultAgent.trim()
    : undefined;
}

export function activeAgentName(sessionManager: PiSessionManager) {
  return getActiveState(sessionManager).agentName;
}

export function filterAvailableAgents(
  config: { agents: AgentDefinition[] },
  policy: { resources: { agents: string[] } },
) {
  const allowed = new Set(policy.resources.agents);

  return config.agents.filter((agent) => allowed.has(agent.name));
}

export function assertAvailableAgent(agentName: unknown, agents: AgentDefinition[]) {
  const agent = agents.find((item) => String(item.name).toLowerCase() === String(agentName ?? "").toLowerCase());

  if (!agent)
    throw new Error(
      `Unavailable agent "${agentName}". Available agents: ${agents.map((item) => item.name).join(", ") || "none"}.`,
    );

  return agent;
}
