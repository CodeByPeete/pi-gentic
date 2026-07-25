import { HashSet } from "effect";

export function applyCapabilityFilter(
  ambientCapabilities: ReadonlyArray<string>,
  filters: ReadonlyArray<string> | undefined,
): Array<string> {
  if (filters === undefined) return [...ambientCapabilities];
  if (filters.length === 0) return [];
  const ceiling = HashSet.fromIterable(ambientCapabilities);
  const includes: Array<string> = [];
  const excludes: Array<string> = [];
  const forceIncludes: Array<string> = [];
  const forceExcludes: Array<string> = [];

  for (const filter of filters) {
    if (filter.length === 0) continue;

    if (filter.startsWith("+")) forceIncludes.push(filter.slice(1));
    else if (filter.startsWith("-")) forceExcludes.push(filter.slice(1));
    else if (filter.startsWith("!")) excludes.push(filter.slice(1));
    else includes.push(filter);
  }

  let selected =
    includes.length === 0
      ? ceiling
      : HashSet.filter(ceiling, (name) => includes.some((pattern) => matchesPattern(name, pattern)));

  selected = HashSet.filter(selected, (name) => !excludes.some((pattern) => matchesPattern(name, pattern)));

  for (const name of ambientCapabilities) {
    if (forceIncludes.some((pattern) => pattern.toLowerCase() === name.toLowerCase())) {
      selected = HashSet.add(selected, name);
    }
  }

  selected = HashSet.filter(
    selected,
    (name) => !forceExcludes.some((pattern) => pattern.toLowerCase() === name.toLowerCase()),
  );

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
