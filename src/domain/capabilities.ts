import { HashSet } from "effect";

export interface ActiveToolSelectionInput {
  readonly registeredToolNames: ReadonlyArray<string>;
  readonly ambientToolNames: ReadonlyArray<string>;
  readonly filters: ReadonlyArray<string> | undefined;
}

export interface ToolPolicyState {
  readonly ambientToolNames: ReadonlyArray<string>;
  readonly appliedToolNames: ReadonlyArray<string>;
}

export interface ActiveToolReconciliationInput {
  readonly registeredToolNames: ReadonlyArray<string>;
  readonly observedToolNames: ReadonlyArray<string>;
  readonly filters: ReadonlyArray<string> | undefined;
  readonly previousState?: ToolPolicyState;
}

export interface ActiveToolReconciliation {
  readonly selection: Array<string>;
  readonly changed: boolean;
  readonly state: ToolPolicyState;
}

export function reconcileActiveToolSelection({
  registeredToolNames,
  observedToolNames,
  filters,
  previousState,
}: ActiveToolReconciliationInput): ActiveToolReconciliation {
  const catalog = HashSet.fromIterable(registeredToolNames);
  const available = (names: ReadonlyArray<string>) => uniqueNames(names).filter((name) => HashSet.has(catalog, name));
  const observed = available(observedToolNames);
  const previousApplied = previousState ? available(previousState.appliedToolNames) : undefined;
  const ambientToolNames =
    previousState && previousApplied && equalNames(observed, previousApplied)
      ? available(previousState.ambientToolNames)
      : observed;
  const selection = resolveActiveToolSelection({ registeredToolNames, ambientToolNames, filters });

  return {
    selection,
    changed: !equalNames(observed, selection),
    state: { ambientToolNames: [...ambientToolNames], appliedToolNames: [...selection] },
  };
}

function equalNames(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export function resolveActiveToolSelection({
  registeredToolNames,
  ambientToolNames,
  filters,
}: ActiveToolSelectionInput): Array<string> {
  const catalog = uniqueNames(registeredToolNames);
  const catalogNames = HashSet.fromIterable(catalog);
  const ambient = uniqueNames(ambientToolNames).filter((name) => HashSet.has(catalogNames, name));

  if (filters === undefined) return ambient;
  if (filters.length === 0) return [];
  const { inclusions, exclusions, additions, removals } = partitionCapabilityFilters(filters);

  const ambientBaseline = inclusions.length === 0 || inclusions.includes("*");
  const baseline = ambientBaseline
    ? ambient
    : catalog.filter((name) => inclusions.some((pattern) => matchesPattern(name, pattern)));
  const additionNames = normalizedNames(additions);
  const removalNames = normalizedNames(removals);

  return uniqueNames([
    ...baseline.filter((name) => !exclusions.some((pattern) => matchesPattern(name, pattern))),
    ...catalog.filter((name) => HashSet.has(additionNames, normalizeName(name))),
  ]).filter((name) => !HashSet.has(removalNames, normalizeName(name)));
}

function uniqueNames(names: ReadonlyArray<string>) {
  return [...new Set(names)];
}

function normalizeName(name: string) {
  return name.toLowerCase();
}

function normalizedNames(names: ReadonlyArray<string>) {
  return HashSet.fromIterable(names.map(normalizeName));
}

function partitionCapabilityFilters(filters: ReadonlyArray<string>) {
  const inclusions: Array<string> = [];
  const exclusions: Array<string> = [];
  const additions: Array<string> = [];
  const removals: Array<string> = [];

  for (const filter of filters) {
    if (filter.length === 0) continue;
    if (filter.startsWith("+")) additions.push(filter.slice(1));
    else if (filter.startsWith("-")) removals.push(filter.slice(1));
    else if (filter.startsWith("!")) exclusions.push(filter.slice(1));
    else inclusions.push(filter);
  }

  return { inclusions, exclusions, additions, removals };
}

export function applyCapabilityFilter(
  ambientCapabilities: ReadonlyArray<string>,
  filters: ReadonlyArray<string> | undefined,
): Array<string> {
  if (filters === undefined) return [...ambientCapabilities];
  if (filters.length === 0) return [];
  const ceiling = HashSet.fromIterable(ambientCapabilities);
  const {
    inclusions: includes,
    exclusions: excludes,
    additions: forceIncludes,
    removals: forceExcludes,
  } = partitionCapabilityFilters(filters);

  let selected =
    includes.length === 0
      ? ceiling
      : HashSet.filter(ceiling, (name) => includes.some((pattern) => matchesPattern(name, pattern)));

  selected = HashSet.filter(selected, (name) => !excludes.some((pattern) => matchesPattern(name, pattern)));

  const forceInclusionNames = normalizedNames(forceIncludes);
  for (const name of ambientCapabilities) {
    if (HashSet.has(forceInclusionNames, normalizeName(name))) {
      selected = HashSet.add(selected, name);
    }
  }

  const forceExclusionNames = normalizedNames(forceExcludes);
  selected = HashSet.filter(selected, (name) => !HashSet.has(forceExclusionNames, normalizeName(name)));

  return ambientCapabilities.filter((name) => HashSet.has(selected, name));
}

export function resolveCapabilitySet(
  ambientCapabilities: ReadonlyArray<string>,
  policyLayers: ReadonlyArray<ReadonlyArray<string> | undefined>,
): Array<string> {
  return policyLayers.reduce<Array<string>>(
    (ceiling, filters) => applyCapabilityFilter(ceiling, filters),
    [...ambientCapabilities],
  );
}

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${escaped}$`, "i").test(name);
}
