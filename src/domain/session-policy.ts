import { applyCapabilityFilter } from "./capabilities.js";
import type { AgentDefinition } from "../infrastructure/configuration/agents.js";
import type { UnknownRecord } from "../shared/types.js";
import { isRecord } from "../shared/value.js";

const FILTER_ALL = ["*"];
const DEFAULT_ACCESS = ["*"];

export function applyFilterList(allNames: string[], filters: unknown = FILTER_ALL) {
  if (!Array.isArray(filters)) return [...allNames];

  return applyCapabilityFilter(
    allNames,
    filters.filter((filter): filter is string => typeof filter === "string"),
  );
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
export function resolveSessionPolicy({
  settings,
  activeAgent,
  overrides,
  allAgents,
  allTools,
  allSkills,
}: {
  settings: UnknownRecord;
  activeAgent?: AgentDefinition;
  overrides?: UnknownRecord;
  allAgents: string[];
  allTools: string[];
  allSkills: string[];
}) {
  const defaults = isRecord(settings.agentDefaults) ? settings.agentDefaults : {};
  const agentless = isRecord(settings.agentlessSession) ? settings.agentlessSession : {};
  const base = activeAgent ? defaults : agentless;
  const merged = mergePolicyObjects(base, activeAgent ?? {});
  const resolved = mergePolicyObjects(merged, overrides ?? {});
  const agentsFilter =
    (activeAgent
      ? mergeFilterLayers(defaults.agents, activeAgent.agents, overrides?.agents)
      : mergeFilterLayers(agentless.agents, overrides?.agents)) ?? DEFAULT_ACCESS;
  const toolsFilter =
    (activeAgent
      ? mergeFilterLayers(defaults.tools, activeAgent.tools, overrides?.tools)
      : mergeFilterLayers(agentless.tools, overrides?.tools)) ?? DEFAULT_ACCESS;
  const skillsFilter =
    (activeAgent
      ? mergeFilterLayers(defaults.skills, activeAgent.skills, overrides?.skills)
      : mergeFilterLayers(agentless.skills, overrides?.skills)) ?? DEFAULT_ACCESS;
  const systemPromptFilesFilter = activeAgent
    ? mergeFilterLayers(defaults.systemPromptFiles, activeAgent.systemPromptFiles, overrides?.systemPromptFiles)
    : mergeFilterLayers(agentless.systemPromptFiles, overrides?.systemPromptFiles);

  return {
    agentName: activeAgent?.name,
    description: typeof resolved.description === "string" ? resolved.description : undefined,
    instructions: typeof resolved.instructions === "string" ? resolved.instructions : undefined,
    model: typeof resolved.model === "string" ? resolved.model : undefined,
    thinking: typeof resolved.thinking === "string" ? resolved.thinking : undefined,
    theme: typeof resolved.theme === "string" ? resolved.theme : undefined,
    maxSubagentDepth: typeof resolved.maxSubagentDepth === "number" ? resolved.maxSubagentDepth : 1,
    agentsTool: mergePolicyObjects(
      isRecord(defaults.agentsTool) ? defaults.agentsTool : {},
      mergePolicyObjects(
        isRecord(activeAgent?.agentsTool) ? activeAgent.agentsTool : {},
        isRecord(overrides?.agentsTool) ? overrides.agentsTool : {},
      ),
    ),
    systemPromptFiles: systemPromptFilesFilter,
    resources: {
      agents: applyFilterList(allAgents, agentsFilter),
      tools: applyFilterList(allTools, toolsFilter),
      skills: applyFilterList(allSkills, skillsFilter),
    },
    toolFilters: [...toolsFilter],
    recipe: {
      agentReference: activeAgent?.name,
      overrides: overrides ?? undefined,
    },
  };
}

function mergePolicyObjects(base: UnknownRecord | undefined, patch: UnknownRecord | undefined) {
  const result = { ...base };

  for (const [key, value] of Object.entries(patch ?? {})) {
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? mergePolicyObjects(result[key], value) : value;
  }

  return result;
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
