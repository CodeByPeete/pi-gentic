import { HashSet } from "effect";

export interface ToolPolicyState {
  readonly ambientToolNames: ReadonlyArray<string>;
  readonly appliedToolNames: ReadonlyArray<string>;
}

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
  const catalog = HashSet.fromIterable(registeredToolNames);
  const available = (names: ReadonlyArray<string>) => uniqueNames(names).filter((name) => HashSet.has(catalog, name));
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
  const catalogNames = HashSet.fromIterable(catalog);
  const ambient = uniqueNames(ambientToolNames).filter((name) => HashSet.has(catalogNames, name));

  const inclusions = partitionCapabilityFilters(filters ?? []).inclusions;
  const baseline = inclusions.length === 0 || inclusions.includes("*") ? ambient : catalog;

  return applyCapabilityPolicy(baseline, catalog, filters);
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

function applyCapabilityPolicy(
  baseline: ReadonlyArray<string>,
  catalog: ReadonlyArray<string>,
  filters: ReadonlyArray<string> | undefined,
) {
  if (filters === undefined) return [...baseline];
  if (filters.length === 0) return [];
  const { inclusions, exclusions, additions, removals } = partitionCapabilityFilters(filters);
  const additionNames = normalizedNames(additions);
  const removalNames = normalizedNames(removals);
  const selected = baseline.filter(
    (name) =>
      (inclusions.length === 0 || inclusions.some((pattern) => matchesPattern(name, pattern))) &&
      !exclusions.some((pattern) => matchesPattern(name, pattern)),
  );
  const selectedNames = HashSet.fromIterable(selected);

  return [
    ...selected,
    ...catalog.filter((name) => !HashSet.has(selectedNames, name) && HashSet.has(additionNames, normalizeName(name))),
  ].filter((name) => !HashSet.has(removalNames, normalizeName(name)));
}

export function applyCapabilityFilter(
  ambientCapabilities: ReadonlyArray<string>,
  filters: ReadonlyArray<string> | undefined,
): Array<string> {
  const selected = HashSet.fromIterable(applyCapabilityPolicy(ambientCapabilities, ambientCapabilities, filters));

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
