import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { loadSkills, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Exit, Schema } from "effect";
import { applyCapabilityFilter } from "./domain/capabilities.js";
import type { PiContext, PiSessionManager, UnknownRecord } from "./pi-types.js";

export interface AgentDefinition extends UnknownRecord {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly disabled: boolean;
  readonly agents?: string[];
  readonly tools?: string[];
  readonly skills?: string[];
  readonly model?: string;
  readonly thinking?: string;
  readonly theme?: string;
  readonly systemPromptFiles?: string[];
  readonly maxSubagentDepth?: number;
  readonly agentsTool?: UnknownRecord;
  readonly sourcePath: string;
}

export interface SkillDefinition extends UnknownRecord {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly allowedTools?: string[];
  readonly disableModelInvocation: boolean;
  readonly instructions: string;
}

const FILTER_ALL = ["*"];

export function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toStringArray(value: unknown) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");

  if (typeof value === "string")
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  return undefined;
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function parseIntegerRadius(value: unknown, fieldName: string, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(number) || number < 0) throw new Error(`${fieldName} must be a non-negative number.`);
  return Math.floor(number);
}

export function chooseBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h:${minutes.toString().padStart(2, "0")}m:${seconds.toString().padStart(2, "0")}s`;

  if (minutes > 0) return `${minutes}m:${seconds.toString().padStart(2, "0")}s`;

  return `${seconds}s`;
}

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

export function coalesce<T, U>(value: T | undefined, fallback: U): T | U {
  return value === undefined ? fallback : value;
}

export function shortSessionId(sessionId: unknown) {
  return String(sessionId ?? "").slice(0, 8);
}

export function shortestUniqueSessionId(sessionId: unknown, sessionIds: unknown[] = []) {
  const full = String(sessionId ?? "");
  let length = Math.min(8, full.length);

  while (
    length < full.length &&
    sessionIds.some((candidate) => {
      const other = String(candidate ?? "");

      return other && other !== full && other.slice(0, length) === full.slice(0, length);
    })
  )
    length = Math.min(full.length, length + (full[length] === "-" ? 5 : 4));

  return full.slice(0, length);
}

export function buildReceiptText(callerAgent: unknown, callerSessionId: unknown, message: string) {
  const agentText = callerAgent ? `[${callerAgent}] agent` : "agent";

  return `Message from ${agentText} from session ${String(callerSessionId ?? "")}:\n${message}\nComplete the task before answering. Only your final result will be returned.`;
}

export function buildReturnText(agent: unknown, sessionId: unknown, finalAnswer: string) {
  const agentText = agent ? `[${agent}] agent` : "agent";

  return `Message from ${agentText} from session ${String(sessionId ?? "")}:\n${finalAnswer}`;
}

const EXTENSION_DIR = path.join("extensions", "pi-gentic");
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

export function defaultAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

export function getConfigRoots(cwd = process.cwd(), agentDir = defaultAgentDir(), projectTrusted = false) {
  const roots = [path.join(agentDir, EXTENSION_DIR)];

  if (projectTrusted) {
    const projectRoot = findNearestProjectConfigRoot(cwd);

    if (projectRoot) roots.push(projectRoot);
  }

  return roots;
}

function findNearestProjectConfigRoot(cwd: string) {
  let current = path.resolve(cwd);

  while (true) {
    const candidate = path.join(current, ".pi", EXTENSION_DIR);

    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);

    if (parent === current) return null;
    current = parent;
  }
}

export function loadPiSettings(
  agentDir = defaultAgentDir(),
  cwd = process.cwd(),
  diagnostics: UnknownRecord[] = [],
  projectTrusted = false,
) {
  const settings: UnknownRecord = {};
  const paths = [
    path.join(agentDir, "settings.json"),
    ...(projectTrusted ? ancestorDirs(cwd, ".pi", "settings.json") : []),
  ];

  for (const settingsPath of dedupePaths(paths)) {
    const source = readJson(settingsPath, diagnostics);

    if (source) mergePiSettings(settings, source);
  }

  return settings;
}

export function enabledModelPatterns(agentDir = defaultAgentDir()) {
  const settings = loadPiSettings(agentDir);

  return toStringArray(settings.enabledModels);
}

export function loadConfiguration(options: UnknownRecord = {}) {
  const cwd = typeof options.cwd === "string" ? options.cwd : undefined;
  const agentDir = typeof options.agentDir === "string" ? options.agentDir : undefined;
  const roots = Array.isArray(options.roots)
    ? options.roots.filter((root): root is string => typeof root === "string")
    : getConfigRoots(cwd, agentDir, options.projectTrusted === true);
  const settings = createDefaultSettings();
  const agentsByName = new Map<string, AgentDefinition>();
  const diagnostics: UnknownRecord[] = [];

  for (const root of roots) {
    const settingsPath = path.join(root, "settings.json");
    const rootSettings = readJson(settingsPath, diagnostics);

    if (rootSettings) {
      mergeRootSettings(settings, rootSettings);

      for (const definition of normalizeAgentDefinitions(rootSettings.agentDefinitions, settingsPath, diagnostics)) {
        agentsByName.set(String(definition.name), definition);
      }
    }

    for (const definition of loadMarkdownAgents(path.join(root, "agents"), diagnostics)) {
      agentsByName.set(String(definition.name), definition);
    }
  }

  const agents = [...agentsByName.values()].filter((agent) => agent.disabled !== true);

  return {
    settings: { ...settings, agentDefinitions: agents },
    agents,
    diagnostics,
    roots,
  };
}

function createDefaultSettings() {
  return {
    agentlessSession: {},
    agentDefinitions: [],
    agentDefaults: {},
    globalMaxSubagentDepth: 6,
    sessionMessagingScope: "tree",
  };
}

function readJson(filePath: string, diagnostics: UnknownRecord[]): UnknownRecord | undefined {
  if (!existsSync(filePath)) return undefined;

  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));

    return Schema.decodeUnknownSync(JsonObjectSchema)(parsed);
  } catch (error) {
    diagnostics.push({
      severity: "error",
      path: filePath,
      message: `Could not parse JSON: ${error instanceof Error ? error.message : String(error)}`,
    });

    return undefined;
  }
}

function mergeRootSettings(target: UnknownRecord, source: unknown) {
  if (!isRecord(source)) return;

  if (isRecord(source.agentlessSession))
    target.agentlessSession = mergeObjects(
      isRecord(target.agentlessSession) ? target.agentlessSession : {},
      source.agentlessSession,
    );

  if (isRecord(source.agentDefaults))
    target.agentDefaults = mergeObjects(
      isRecord(target.agentDefaults) ? target.agentDefaults : {},
      source.agentDefaults,
    );

  if (typeof source.defaultAgent === "string" || source.defaultAgent === null)
    target.defaultAgent = source.defaultAgent;

  if (Number.isFinite(Number(source.globalMaxSubagentDepth))) {
    target.globalMaxSubagentDepth = Math.floor(Number(source.globalMaxSubagentDepth));
  }

  if (typeof source.sessionMessagingScope === "string" && ["tree", "all"].includes(source.sessionMessagingScope))
    target.sessionMessagingScope = source.sessionMessagingScope;
}

function mergeObjects(base: UnknownRecord, patch: UnknownRecord) {
  const result = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    result[key] = isRecord(value) && isRecord(result[key]) ? mergeObjects(result[key], value) : value;
  }

  return result;
}

function loadMarkdownAgents(dir: string, diagnostics: UnknownRecord[]) {
  if (!existsSync(dir)) return [];
  let entries: import("node:fs").Dirent[] = [];

  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      severity: "warning",
      path: dir,
      message: `Could not read agents directory: ${error instanceof Error ? error.message : String(error)}`,
    });

    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .flatMap((entry) => loadMarkdownAgent(path.join(dir, entry.name), diagnostics));
}

function loadMarkdownAgent(filePath: string, diagnostics: UnknownRecord[]) {
  try {
    const content = readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseMarkdownDefinition(content);
    const metadata = frontmatter;
    const definition = normalizeAgentDefinition(
      { ...metadata, instructions: body.trim() || metadata.instructions },
      filePath,
      diagnostics,
    );

    return definition ? [definition] : [];
  } catch (error) {
    diagnostics.push({
      severity: "warning",
      path: filePath,
      message: `Could not load agent: ${error instanceof Error ? error.message : String(error)}`,
    });

    return [];
  }
}

function normalizeAgentDefinitions(value: unknown, sourcePath: string, diagnostics: UnknownRecord[]) {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item, index) => {
    const definition = normalizeAgentDefinition(item, `${sourcePath}#agentDefinitions[${index}]`, diagnostics);

    return definition ? [definition] : [];
  });
}

export function normalizeAgentDefinition(
  value: unknown,
  sourcePath = "inline",
  diagnostics: UnknownRecord[] = [],
): AgentDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === "string" ? value.name.trim() : "";

  if (!name) {
    diagnostics.push({
      severity: "warning",
      path: sourcePath,
      message: "Ignored unnamed agent definition.",
    });

    return undefined;
  }

  const model =
    typeof value.model === "string"
      ? value.model
      : Array.isArray(value.models)
        ? value.models.find((item) => typeof item === "string")
        : undefined;

  return removeUndefined<AgentDefinition>({
    name,
    description: typeof value.description === "string" ? value.description : "",
    instructions: typeof value.instructions === "string" ? value.instructions : "",
    disabled: value.disabled === true,
    agents: toStringArray(value.agents),
    tools: toStringArray(value.tools),
    skills: toStringArray(value.skills),
    model,
    thinking: typeof value.thinking === "string" ? value.thinking : undefined,
    theme: typeof value.theme === "string" ? value.theme : undefined,
    systemPromptFiles: toStringArray(value.systemPromptFiles),
    maxSubagentDepth: numberOrUndefined(value.maxSubagentDepth),
    agentsTool: normalizeAgentsTool(value.agentsTool),
    sourcePath,
  });
}

function normalizeAgentsTool(value: unknown) {
  if (!isRecord(value)) return undefined;

  return removeUndefined({
    async: booleanOrUndefined(value.async),
    fork: booleanOrUndefined(value.fork),
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    invokeMeLater: isRecord(value.invokeMeLater)
      ? removeUndefined({
          async: booleanOrUndefined(value.invokeMeLater.async),
          withSession: booleanOrUndefined(value.invokeMeLater.withSession),
        })
      : undefined,
    rx: numberOrUndefined(value.rx),
    ry: numberOrUndefined(value.ry),
    open: booleanOrUndefined(value.open),
  });
}

function booleanOrUndefined(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function numberOrUndefined(value: unknown) {
  const number = Number(value);

  return Number.isFinite(number) ? Math.floor(number) : undefined;
}

function removeUndefined<T extends UnknownRecord>(object: T): T {
  for (const key of Object.keys(object)) if (object[key] === undefined) delete object[key];

  return object;
}

export function parseMarkdownDefinition(content: string): {
  frontmatter: UnknownRecord;
  body: string;
} {
  const { frontmatter, body } = parseFrontmatter(content);

  return {
    frontmatter: Schema.decodeUnknownSync(JsonObjectSchema)(frontmatter ?? {}),
    body,
  };
}

function mergePiSettings(target: UnknownRecord, source: UnknownRecord) {
  for (const [key, value] of Object.entries(source))
    target[key] = isRecord(value) && isRecord(target[key]) ? mergeObjects(target[key], value) : value;
}

function ancestorDirs(cwd: string, ...parts: string[]) {
  const dirs: string[] = [];
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    dirs.unshift(path.join(current, ...parts));
    if (path.dirname(current) === current) return dirs;
  }
}

function dedupePaths(paths: string[]) {
  return [...new Set(paths.filter(Boolean).map((item) => path.resolve(String(item))))];
}

const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function loadAvailableSkills(options: UnknownRecord = {}) {
  const cwd = path.resolve(text(options.cwd) ?? process.cwd());
  const agentDir = path.resolve(text(options.agentDir) ?? defaultAgentDir());
  const diagnostics = Array.isArray(options.diagnostics) ? options.diagnostics : [];
  const projectTrusted = options.projectTrusted === true;
  const settings = isRecord(options.settings)
    ? options.settings
    : loadPiSettings(agentDir, cwd, diagnostics, projectTrusted);
  const configuredRoots = strings(options.skillRoots)?.map((root) => path.resolve(root));
  const roots = options.noSkills
    ? []
    : (configuredRoots ?? skillRoots(cwd, agentDir, settings, diagnostics, projectTrusted));
  const skillPaths = uniquePaths([
    ...roots,
    ...explicitSkillPaths([...refs(settings.skills), ...refs(options.skills)], cwd, agentDir, diagnostics),
  ]).filter(existsSync);
  const loaded = loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false });

  const loadedPaths = new Set(loaded.skills.map((skill) => skill.filePath));
  const omittedPaths = new Set<string>();

  for (const diagnostic of loaded.diagnostics) {
    if (diagnostic.type !== "collision") {
      if (!diagnostic.path || loadedPaths.has(diagnostic.path) || omittedPaths.has(diagnostic.path)) continue;
      omittedPaths.add(diagnostic.path);
    }
    diagnostics.push({
      severity: diagnostic.type === "error" ? "error" : "warning",
      path: diagnostic.path,
      message: diagnostic.message,
    });
  }

  return dedupeSkills(
    loaded.skills.flatMap((skill) => loadSkillEntry(skill.filePath, diagnostics)),
    diagnostics,
  );
}

export function findAvailableSkill(name: unknown, options: UnknownRecord = {}) {
  const query = String(name ?? "").toLowerCase();

  return loadAvailableSkills(options).find((skill) => String(skill.name).toLowerCase() === query);
}

export function systemPromptSkillEntries(ctx: PiContext) {
  const skills = ctx.getSystemPromptOptions?.()?.skills;

  return Array.isArray(skills)
    ? skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        location: skill.filePath,
        disableModelInvocation: skill.disableModelInvocation,
      }))
    : [];
}

function skillRoots(
  cwd: string,
  agentDir: string,
  settings: UnknownRecord,
  diagnostics: UnknownRecord[],
  projectTrusted: boolean,
) {
  return uniquePaths([
    path.join(agentDir, "skills"),
    path.join(homedir(), ".agents", "skills"),
    ...(projectTrusted
      ? [
          ...ancestorDirs(cwd, ".agents", "skills"),
          ...ancestorDirs(cwd, ".pi", "skills"),
          ...packageSkillRoots(cwd, settings, diagnostics),
        ]
      : []),
  ]);
}

function explicitSkillPaths(entries: unknown[], cwd: string, agentDir: string, diagnostics: UnknownRecord[]) {
  return entries.flatMap((entry) => {
    const ref = refPath(entry);
    const resolved = ref
      ? uniquePaths([path.isAbsolute(ref) ? ref : path.resolve(cwd, ref), path.resolve(agentDir, ref)]).find(existsSync)
      : undefined;

    if (resolved) return [resolved];
    if (ref)
      diagnostics.push({
        severity: "warning",
        path: ref,
        message: `Could not resolve configured skill "${ref}".`,
      });
    return [];
  });
}

function packageSkillRoots(cwd: string, settings: UnknownRecord, diagnostics: UnknownRecord[]) {
  return [
    ...nearestPackageRoots(cwd),
    ...refs(settings.packages).flatMap((entry) => resolvePackageRoot(entry, cwd, diagnostics) ?? []),
  ].flatMap((root) => packageSkillRootsFromManifest(root, diagnostics));
}

function nearestPackageRoots(cwd: string) {
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    if (existsSync(path.join(current, "package.json"))) return [current];
    if (path.dirname(current) === current) return [];
  }
}

function packageSkillRootsFromManifest(root: string, diagnostics: UnknownRecord[]) {
  const manifest = readSkillJson(path.join(root, "package.json"), diagnostics);
  const declared = isRecord(manifest?.pi) ? refs(manifest.pi.skills) : [];
  const skillRoots = declared.length
    ? declared.map((entry) => resolvePackageSkillRef(entry, root))
    : [path.join(root, "skills")];

  return skillRoots.filter((item): item is string => Boolean(item && existsSync(item)));
}

function resolvePackageRoot(entry: unknown, cwd: string, diagnostics: UnknownRecord[]) {
  const ref = refPath(entry);
  if (!ref) return undefined;

  const candidate = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
  if (existsSync(path.join(candidate, "package.json"))) return candidate;
  const packageName = ref.startsWith("npm:") ? ref.slice(4) : ref;

  try {
    return path.dirname(createRequire(path.join(cwd, "package.json")).resolve(`${packageName}/package.json`));
  } catch (error) {
    diagnostics.push({
      severity: "debug",
      message: `Could not resolve skill package ${packageName}: ${getErrorMessage(error)}`,
    });
    return undefined;
  }
}

function resolvePackageSkillRef(entry: unknown, root: string) {
  const ref = refPath(entry);

  return ref ? (path.isAbsolute(ref) ? ref : path.resolve(root, ref)) : undefined;
}

function loadSkillEntry(filePath: string, diagnostics: UnknownRecord[]): SkillDefinition[] {
  try {
    const { frontmatter, body } = parseMarkdownDefinition(readFileSync(filePath, "utf8"));
    const metadata = frontmatter;
    const name = text(metadata.name)?.trim() ?? "";
    const description = text(metadata.description)?.trim() ?? "";

    if (!SKILL_NAME_PATTERN.test(name)) {
      diagnostics.push({
        severity: "warning",
        path: filePath,
        message: `Ignored skill with invalid name "${name || "missing"}".`,
      });
      return [];
    }

    if (!description) {
      diagnostics.push({
        severity: "warning",
        path: filePath,
        message: `Ignored skill "${name}" because it has no description.`,
      });
      return [];
    }

    return [
      compact<SkillDefinition>({
        name,
        description,
        location: filePath,
        source: text(metadata.source),
        license: text(metadata.license),
        compatibility: toStringArray(metadata.compatibility),
        metadata: isRecord(metadata.metadata) ? metadata.metadata : undefined,
        allowedTools: toolRefs(metadata["allowed-tools"] ?? metadata.allowedTools),
        disableModelInvocation:
          metadata["disable-model-invocation"] === true || metadata.disableModelInvocation === true,
        instructions: body.trim(),
      }),
    ];
  } catch (error) {
    diagnostics.push(diag("warning", filePath, "Could not load skill", error));
    return [];
  }
}

function dedupeSkills(skills: SkillDefinition[], diagnostics: UnknownRecord[]) {
  const byName = new Map<string, SkillDefinition>();

  for (const skill of skills) {
    const key = String(skill.name).toLowerCase();
    const original = byName.get(key);

    if (!original) byName.set(key, skill);
    else
      diagnostics.push({
        severity: "warning",
        path: String(skill.location ?? ""),
        message: `Ignored duplicate skill "${skill.name}" from ${skill.location}; first definition from ${original.location} is active.`,
      });
  }

  return [...byName.values()];
}

function readSkillJson(filePath: string, diagnostics: UnknownRecord[]) {
  if (!existsSync(filePath)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    diagnostics.push(diag("warning", filePath, "Could not parse JSON", error));
    return undefined;
  }
}

function refs(value: unknown) {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function refPath(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";

  for (const key of ["path", "location", "root", "package"]) {
    const ref = text(value[key])?.trim();
    if (ref) return ref;
  }

  return "";
}

function toolRefs(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.flatMap((item) => toolRefs(item) ?? []);
  return typeof value === "string"
    ? value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.filter(Boolean).map((item) => path.resolve(String(item))))];
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function compact<T extends UnknownRecord>(object: T): T {
  for (const key of Object.keys(object)) if (object[key] === undefined) delete object[key];

  return object;
}

function diag(severity: string, filePath: string, message: string, error: unknown) {
  return {
    severity,
    path: filePath,
    message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
  };
}

const DEFAULT_ACCESS = ["*"];

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

function mergePolicyObjects(base: UnknownRecord | undefined, patch: UnknownRecord | undefined) {
  const result = { ...(base ?? {}) };

  for (const [key, value] of Object.entries(patch ?? {})) {
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? mergePolicyObjects(result[key], value) : value;
  }

  return result;
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertCanCreateSubagent({
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
    throw new Error(
      `Cannot create a child session because maxSubagentDepth is ${localLimit}. Reuse an existing session or raise the local limit.`,
    );

  if (nextDepth > globalLimit)
    throw new Error(
      `Cannot create a child session at depth ${nextDepth} because globalMaxSubagentDepth is ${globalLimit}. Reuse an existing session or raise the global limit.`,
    );
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

export function hasPersistedAgentState(sessionManager: PiSessionManager) {
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

export function buildResolvedSystemPrompt({
  baseSystemPrompt,
  config,
  policy,
}: {
  baseSystemPrompt: string;
  config: UnknownRecord;
  policy: UnknownRecord;
  skillEntries?: UnknownRecord[];
}) {
  const extensionSections = [
    policy.instructions,
    ...delegationSections(config, policy),
    ...promptFileSections(config, policy.systemPromptFiles),
    agentsSection(config, policy),
    namingSection(policy),
  ]
    .map((section) => String(section ?? "").trim())
    .filter(Boolean);

  if (extensionSections.length === 0) return baseSystemPrompt;
  const extensionContext = ["<pi-gentic-context>", ...extensionSections, "</pi-gentic-context>"].join("\n\n");

  return baseSystemPrompt.length > 0 ? `${baseSystemPrompt}\n\n${extensionContext}` : extensionContext;
}

export function mergeSkillEntries(primary: UnknownRecord[] = [], secondary: UnknownRecord[] = []) {
  const merged = new Map<string, UnknownRecord>();

  for (const entry of [...primary, ...secondary]) {
    const name = typeof entry.name === "string" ? entry.name : undefined;

    if (!name) continue;
    const current = merged.get(name);
    merged.set(name, current ? { ...entry, ...current } : entry);
  }

  return [...merged.values()];
}

export function availableAgentLines(agents: UnknownRecord[], allowedNames: string[]) {
  const allowed = new Set(allowedNames);
  const lines = agents
    .filter((agent) => allowed.has(String(agent.name)))
    .map((agent) => `- ${String(agent.name)}: ${String(agent.description ?? "")}`.trim());

  return lines.join("\n") || "none";
}

export function parseSkillEntries(_systemPrompt: unknown): UnknownRecord[] {
  return [];
}

export function filterSkillPrompt(systemPrompt: unknown, _skillEntries: UnknownRecord[], _allowedSkills: string[]) {
  return String(systemPrompt ?? "");
}

function delegationSections(config: UnknownRecord, policy: UnknownRecord) {
  if (!canUseAgentsTool(policy)) return [];

  return configurationRoots(config)
    .map((root) => readPromptFile(path.join(root, "DELEGATION.md"), config))
    .filter((content) => content.length > 0);
}

function promptFileSections(config: UnknownRecord, filters: unknown) {
  return promptFileRefs(filters)
    .map((filePath) => readPromptFile(filePath, config))
    .filter((content) => content.length > 0);
}

function promptFileRefs(filters: unknown): string[] {
  if (!Array.isArray(filters)) return [];

  return filters.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const value = entry.trim();

    if (value.startsWith("+")) return [value.slice(1)];
    if (
      value.length === 0 ||
      value === "*" ||
      value.startsWith("!") ||
      value.startsWith("-") ||
      value.includes("*") ||
      value.includes("?")
    ) {
      return [];
    }

    return [value];
  });
}

function agentsSection(config: UnknownRecord, policy: UnknownRecord) {
  if (!canUseAgentsTool(policy)) return "";
  const resources = isRecord(policy.resources) ? policy.resources : {};
  const agents = Array.isArray(config.agents) ? config.agents.filter(isRecord) : [];
  const allowed = Array.isArray(resources.agents)
    ? resources.agents.filter((name): name is string => typeof name === "string")
    : [];
  const lines = availableAgentLines(agents, allowed);

  return lines === "none" ? "" : `Available agents\n${lines}`;
}

function namingSection(policy: UnknownRecord) {
  return canUseAgentsTool(policy) ? "When generating a session or worktree name, it must be 3 words long max." : "";
}

function canUseAgentsTool(policy: UnknownRecord) {
  const resources = isRecord(policy.resources) ? policy.resources : {};
  const tools = Array.isArray(resources.tools) ? resources.tools : [];
  const agents = Array.isArray(resources.agents) ? resources.agents : [];

  return tools.includes("agents") && agents.length > 0;
}

function readPromptFile(filePath: string, config: UnknownRecord) {
  const resolved = resolvePromptFile(filePath, config);

  if (!resolved) return "";

  try {
    return readFileSync(resolved, "utf8").trim();
  } catch (error) {
    recordPromptDiagnostic(config, resolved, "Could not read prompt file", error);
    return "";
  }
}

function resolvePromptFile(filePath: string, config: UnknownRecord) {
  if (filePath.length === 0) return undefined;
  const roots = configurationRoots(config);
  const candidates = path.isAbsolute(filePath) ? [filePath] : roots.map((root) => path.resolve(root, filePath));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;

    try {
      const canonicalCandidate = realpathSync(candidate);
      const allowed = roots.some((root) => {
        const canonicalRoot = realpathSync(root);
        const relative = path.relative(canonicalRoot, canonicalCandidate);

        return (
          relative.length > 0 &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      });

      if (allowed) return canonicalCandidate;
      recordPromptDiagnostic(config, candidate, "Ignored prompt file outside trusted configuration roots");
    } catch (error) {
      recordPromptDiagnostic(config, candidate, "Could not validate prompt file", error);
    }
  }

  return undefined;
}

function configurationRoots(config: UnknownRecord): string[] {
  return Array.isArray(config.roots) ? config.roots.filter((root): root is string => typeof root === "string") : [];
}

function recordPromptDiagnostic(config: UnknownRecord, filePath: string, message: string, error?: unknown) {
  if (!Array.isArray(config.diagnostics)) return;
  config.diagnostics.push({
    severity: "warning",
    path: filePath,
    message: error === undefined ? message : `${message}: ${getErrorMessage(error)}`,
  });
}
