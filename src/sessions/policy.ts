import type { AgentDefinition } from "../settings.js";
import type { UnknownRecord } from "../shared/values.js";
import { isRecord, stringValue } from "../shared/values.js";

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

export interface ToolPolicyState {
  readonly ambientToolNames: ReadonlyArray<string>;
  readonly appliedToolNames: ReadonlyArray<string>;
}

type CapabilityPolicy = ReturnType<typeof partitionCapabilityFilters>;

export function reconcileActiveToolSelection({
  registeredToolNames,
  observedToolNames,
  filters,
  previousState,
}: {
  readonly registeredToolNames: ReadonlyArray<string>;
  readonly observedToolNames: ReadonlyArray<string>;
  readonly filters: ReadonlyArray<string> | undefined;
  readonly previousState?: ToolPolicyState;
}) {
  const catalog = new Set(registeredToolNames);
  const available = (names: ReadonlyArray<string>) => uniqueNames(names).filter((name) => catalog.has(name));
  const observed = available(observedToolNames);
  const previousApplied = previousState ? available(previousState.appliedToolNames) : undefined;
  const ambientToolNames =
    previousState && previousApplied && equalNames(observed, previousApplied)
      ? available(previousState.ambientToolNames)
      : observed;
  const selection = selectActiveTools(registeredToolNames, ambientToolNames, filters);

  return {
    selection,
    changed: !equalNames(observed, selection),
    state: { ambientToolNames: [...ambientToolNames], appliedToolNames: [...selection] },
  };
}

function equalNames(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function selectActiveTools(
  registeredToolNames: ReadonlyArray<string>,
  ambientToolNames: ReadonlyArray<string>,
  filters: ReadonlyArray<string> | undefined,
) {
  const catalog = uniqueNames(registeredToolNames);
  const catalogNames = new Set(catalog);
  const ambient = uniqueNames(ambientToolNames).filter((name) => catalogNames.has(name));
  const policy = filters && partitionCapabilityFilters(filters);
  const baseline = !policy || policy.inclusions.length === 0 || policy.inclusions.includes("*") ? ambient : catalog;

  return applyCapabilityPolicy(baseline, catalog, policy);
}

function uniqueNames(names: ReadonlyArray<string>) {
  return [...new Set(names)];
}

function partitionCapabilityFilters(filters: ReadonlyArray<string>) {
  const groups = Map.groupBy(filters.filter(Boolean), (filter) =>
    ["+", "-", "!"].includes(filter[0] ?? "") ? filter[0] : "",
  );
  const values = (prefix: string) => (groups.get(prefix) ?? []).map((filter) => filter.slice(prefix.length));

  return {
    inclusions: values(""),
    exclusions: values("!"),
    additions: values("+"),
    removals: values("-"),
    empty: filters.length === 0,
  };
}

function applyCapabilityPolicy(
  baseline: ReadonlyArray<string>,
  catalog: ReadonlyArray<string>,
  policy: CapabilityPolicy | undefined,
) {
  if (!policy) return [...baseline];
  if (policy.empty) return [];
  const { inclusions, exclusions, additions, removals } = policy;
  const additionNames = new Set(additions.map(normalizeName));
  const removalNames = new Set(removals.map(normalizeName));
  const selected = baseline.filter(
    (name) =>
      (inclusions.length === 0 || inclusions.some((pattern) => matchesPattern(name, pattern))) &&
      !exclusions.some((pattern) => matchesPattern(name, pattern)),
  );
  const selectedNames = new Set(selected);

  return [
    ...selected,
    ...catalog.filter((name) => !selectedNames.has(name) && additionNames.has(normalizeName(name))),
  ].filter((name) => !removalNames.has(normalizeName(name)));
}

export function applyCapabilityFilter(
  ambientCapabilities: ReadonlyArray<string>,
  filters: ReadonlyArray<string> | undefined,
): Array<string> {
  const selected = new Set(
    applyCapabilityPolicy(ambientCapabilities, ambientCapabilities, filters && partitionCapabilityFilters(filters)),
  );

  return ambientCapabilities.filter((name) => selected.has(name));
}

function normalizeName(name: string) {
  return name.toLowerCase();
}

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${escaped}$`, "i").test(name);
}
