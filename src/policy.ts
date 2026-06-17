/**
 * Policy and active-agent state.
 *
 * A session stores a tiny append-only recipe. This module resolves that recipe
 * against current settings and current resources every time policy is needed.
 */
import { applyFilterList, coalesce, isRecord, mergeFilterLayers } from "./core.js";

const DEFAULT_ACCESS = ["*"];

/** Combines defaults, the active agent, and runtime overrides into usable policy. */
export function resolveSessionPolicy({
  settings,
  activeAgent,
  overrides,
  allAgents,
  allTools,
  allSkills,
}) {
  const defaults = settings.agentDefaults ?? {};
  const agentless = settings.agentlessSession ?? {};
  const base = activeAgent ? defaults : agentless;
  const merged = mergeObjects(base, activeAgent ?? {});
  const resolved = mergeObjects(merged, overrides ?? {});
  const agentsFilter =
    (activeAgent
      ? mergeFilterLayers(
          defaults.agents,
          activeAgent.agents,
          overrides?.agents,
        )
      : mergeFilterLayers(agentless.agents, overrides?.agents)) ??
    DEFAULT_ACCESS;
  const toolsFilter =
    (activeAgent
      ? mergeFilterLayers(defaults.tools, activeAgent.tools, overrides?.tools)
      : mergeFilterLayers(agentless.tools, overrides?.tools)) ?? DEFAULT_ACCESS;
  const skillsFilter =
    (activeAgent
      ? mergeFilterLayers(
          defaults.skills,
          activeAgent.skills,
          overrides?.skills,
        )
      : mergeFilterLayers(agentless.skills, overrides?.skills)) ??
    DEFAULT_ACCESS;
  const systemPromptFilesFilter = activeAgent
    ? mergeFilterLayers(
        defaults.systemPromptFiles,
        activeAgent.systemPromptFiles,
        overrides?.systemPromptFiles,
      )
    : mergeFilterLayers(
        agentless.systemPromptFiles,
        overrides?.systemPromptFiles,
      );

  return {
    agentName: activeAgent?.name,
    description: resolved.description,
    instructions: resolved.instructions,
    model: resolved.model,
    thinking: resolved.thinking,
    theme: resolved.theme,
    maxSubagentDepth: coalesce(
      resolved.maxSubagentDepth,
      activeAgent ? 2 : settings.globalMaxSubagentDepth,
    ),
    agentsTool: mergeObjects(
      defaults.agentsTool ?? {},
      mergeObjects(activeAgent?.agentsTool ?? {}, overrides?.agentsTool ?? {}),
    ),
    systemPromptFiles: systemPromptFilesFilter,
    resources: {
      agents: applyFilterList(allAgents, agentsFilter),
      tools: applyFilterList(allTools, toolsFilter),
      skills: applyFilterList(allSkills, skillsFilter),
    },
    recipe: {
      agentReference: activeAgent?.name,
      overrides: overrides ?? undefined,
    },
  };
}

/** Reads the latest pi-gentic state entry from append-only session history. */
export function getActiveState(sessionManager) {
  const entries = sessionManager.getEntries?.() ?? [];

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];

    if (entry.type === "custom" && entry.customType === "pi-gentic:state") {
      return sanitizeState(entry.data);
    }
  }

  return { agentName: undefined, overrides: undefined };
}

/** Writes a new durable active-agent recipe without mutating older entries. */
export function appendActiveState(sessionManager, state) {
  sessionManager.appendCustomEntry("pi-gentic:state", sanitizeState(state));
}

function sanitizeState(value) {
  if (!value || typeof value !== "object")
    return { agentName: undefined, overrides: undefined };
  return {
    agentName:
      typeof value.agentName === "string" && value.agentName
        ? value.agentName
        : undefined,
    overrides:
      value.overrides && typeof value.overrides === "object"
        ? value.overrides
        : undefined,
  };
}

function mergeObjects(base, patch) {
  const result = { ...(base ?? {}) };

  for (const [key, value] of Object.entries(patch ?? {})) {
    result[key] =
      isPlainObject(value) && isPlainObject(result[key])
        ? mergeObjects(result[key], value)
        : value;
  }

  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const AGENT_CYCLE_SHORTCUT = "f7";

export function nextAgentName(currentAgentName, agents) {
  const cycle = [undefined, ...agents.map((agent) => agent.name)];
  const index = cycle.findIndex((name) => name === currentAgentName);

  return cycle[index === -1 ? 1 : (index + 1) % cycle.length];
}

export function hasPersistedAgentState(sessionManager) {
  return (sessionManager.getEntries?.() ?? []).some(
    (entry) =>
      entry.type === "custom" && entry.customType === "pi-gentic:state",
  );
}

export function shouldApplyDefaultAgent(event, sessionManager) {
  return (
    ["new", "startup"].includes(event?.reason) &&
    isBlankSession(sessionManager) &&
    !hasPersistedAgentState(sessionManager)
  );
}

function isBlankSession(sessionManager) {
  const context = sessionManager.buildSessionContext?.();

  if (context) return (context.messages ?? []).length === 0;

  return !(sessionManager.getEntries?.() ?? []).some(
    (entry) => entry.type === "message" || entry.type === "custom_message",
  );
}

export function configuredDefaultAgent(settings) {
  return typeof settings?.defaultAgent === "string" &&
    settings.defaultAgent.trim()
    ? settings.defaultAgent.trim()
    : undefined;
}

export function activeAgentName(sessionManager) {
  return getActiveState(sessionManager).agentName;
}

export function filterAvailableAgents(config: AnyRecord, policy: AnyRecord) {
  const resources = policy.resources;
  const allowedAgents = Array.isArray(resources?.agents)
    ? resources.agents.map(String)
    : [];
  const allowed = new Set(allowedAgents);
  const agents = Array.isArray(config.agents)
    ? config.agents.filter(isRecord)
    : [];

  return agents.filter((agent) => allowed.has(String(agent.name)));
}

export function assertAvailableAgent(agentName: unknown, agents: AnyRecord[]) {
  const agent = agents.find(
    (item) => String(item.name).toLowerCase() === String(agentName ?? "").toLowerCase(),
  );

  if (!agent)
    throw new Error(
      `Unavailable agent "${agentName}". Available agents: ${agents.map((item) => item.name).join(", ") || "none"}.`,
    );

  return agent;
}
