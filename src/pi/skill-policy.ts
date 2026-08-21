import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { applyCapabilityFilter } from "../sessions/policy.js";

interface SkillPolicySession {
  readonly resourceLoader: ResourceLoader;
}

interface SkillPolicyLoaderState {
  readonly loader: ResourceLoader;
  readonly nativeLoader: ResourceLoader;
  readonly policy: { filters: ReadonlyArray<string> };
}

const skillPolicyLoaders = new WeakMap<ResourceLoader, SkillPolicyLoaderState>();

/** Installs or updates a skill-filtering view over Pi's native session resource loader. */
export function applySessionSkillPolicy(session: SkillPolicySession, filters: ReadonlyArray<string>) {
  const currentLoader = session.resourceLoader;
  const currentState = skillPolicyLoaders.get(currentLoader);

  if (currentState) {
    if (equalFilters(currentState.policy.filters, filters)) return false;
    currentState.policy.filters = [...filters];
    return true;
  }

  const state = createSkillPolicyLoader(currentLoader, filters);

  if (!Reflect.set(session, "_resourceLoader", state.loader) || session.resourceLoader !== state.loader)
    throw new Error("The installed Pi session does not support resource-loader policy installation.");

  return true;
}

/** Returns the native skill catalog so later policy changes can restore previously filtered skills. */
export function nativeSessionSkillNames(session: SkillPolicySession) {
  const loader = skillPolicyLoaders.get(session.resourceLoader)?.nativeLoader ?? session.resourceLoader;

  return loader.getSkills().skills.map((skill) => skill.name);
}

function createSkillPolicyLoader(nativeLoader: ResourceLoader, filters: ReadonlyArray<string>) {
  const policy = { filters: [...filters] };
  const loader = new Proxy(nativeLoader, {
    get(target, property) {
      if (property === "getSkills") return () => filteredSkills(target, policy.filters);
      const value = Reflect.get(target, property, target);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const state = { loader, nativeLoader, policy };

  skillPolicyLoaders.set(loader, state);
  return state;
}

function filteredSkills(loader: ResourceLoader, filters: ReadonlyArray<string>) {
  const loaded = loader.getSkills();
  const selectedNames = new Set(
    applyCapabilityFilter(
      loaded.skills.map((skill) => skill.name),
      filters,
    ),
  );

  return {
    ...loaded,
    skills: loaded.skills.filter((skill) => selectedNames.has(skill.name)),
  };
}

function equalFilters(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((filter, index) => filter === right[index]);
}
