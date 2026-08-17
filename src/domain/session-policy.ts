import type { AgentDefinition } from "./configuration.js";
import { applyCapabilityFilter } from "./capabilities.js";
import type { UnknownRecord } from "../shared/types.js";
import { isRecord, stringValue } from "../shared/value.js";

const DEFAULT_ACCESS = ["*"];

type ResourceKey = "agents" | "tools" | "skills";

export function applyFilterList(allNames: string[], filters: unknown = DEFAULT_ACCESS) {
  return Array.isArray(filters)
    ? applyCapabilityFilter(
        allNames,
        filters.filter((filter): filter is string => typeof filter === "string"),
      )
    : [...allNames];
}

export function mergeFilterLayers(...layers: unknown[]) {
  const filters = layers.filter(Array.isArray);

  if (filters.length === 0) return undefined;
  return filters.some((layer) => layer.length === 0) ? [] : filters.flatMap((layer) => layer);
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
  const defaults = record(settings.agentDefaults);
  const agentless = record(settings.agentlessSession);
  const layers = activeAgent ? [defaults, activeAgent, overrides] : [agentless, overrides];
  const resolved = mergePolicyObjects(...layers);
  const filter = (key: ResourceKey) => mergeFilterLayers(...layers.map((layer) => layer?.[key])) ?? DEFAULT_ACCESS;
  const agentsFilter = filter("agents");
  const toolsFilter = filter("tools");
  const skillsFilter = filter("skills");

  return {
    agentName: activeAgent?.name,
    description: stringValue(resolved.description),
    instructions: stringValue(resolved.instructions),
    model: stringValue(resolved.model),
    thinking: stringValue(resolved.thinking),
    theme: stringValue(resolved.theme),
    maxSubagentDepth: typeof resolved.maxSubagentDepth === "number" ? resolved.maxSubagentDepth : 1,
    agentsTool: mergePolicyObjects(...layers.map((layer) => record(layer?.agentsTool))),
    systemPromptFiles: mergeFilterLayers(...layers.map((layer) => layer?.systemPromptFiles)),
    resources: {
      agents: applyFilterList(allAgents, agentsFilter),
      tools: applyFilterList(allTools, toolsFilter),
      skills: applyFilterList(allSkills, skillsFilter),
    },
    toolFilters: [...toolsFilter],
    recipe: { agentReference: activeAgent?.name, overrides },
  };
}

function mergePolicyObjects(...sources: unknown[]): UnknownRecord {
  return sources.filter(isRecord).reduce<UnknownRecord>((result, source) => {
    for (const [key, value] of Object.entries(source))
      result[key] = isRecord(value) && isRecord(result[key]) ? mergePolicyObjects(result[key], value) : value;
    return result;
  }, {});
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}
