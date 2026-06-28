import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

declare global {
  type AnyRecord = Record<string, any>;
  type PiApi = AnyRecord;
  type PiContext = AnyRecord;
  type PiSessionManager = AnyRecord;
  type PiRuntimeSession = AnyRecord;
  type PiAgentRuntimeHost = AnyRecord;
  type PiAgentSession = AnyRecord;
  type PiTheme = AnyRecord;
}


const FILTER_ALL = ["*"];

export function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toStringArray(value) {
  if (Array.isArray(value))
    return value.filter((item) => typeof item === "string");

  if (typeof value === "string")
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  return undefined;
}

export function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function parseIntegerRadius(value, fieldName, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(number) || number < 0)
    throw new Error(`${fieldName} must be a non-negative number.`);
  return Math.floor(number);
}

export function chooseBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0)
    return `${hours}h:${minutes.toString().padStart(2, "0")}m:${seconds.toString().padStart(2, "0")}s`;

  if (minutes > 0) return `${minutes}m:${seconds.toString().padStart(2, "0")}s`;

  return `${seconds}s`;
}

function wildcardToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(name, pattern) {
  if (pattern === "*") return true;

  if (pattern.includes("*") || pattern.includes("?"))
    return wildcardToRegExp(pattern).test(name);
  return name.toLowerCase().includes(pattern.toLowerCase());
}

export function applyFilterList(allNames: string[], filters = FILTER_ALL) {
  if (!Array.isArray(filters)) return [...allNames];

  if (filters.length === 0) return [];
  const includes: string[] = [];
  const excludes: string[] = [];
  const forceIncludes: string[] = [];
  const forceExcludes: string[] = [];

  for (const raw of filters) {
    if (typeof raw !== "string" || !raw) continue;

    if (raw.startsWith("+")) forceIncludes.push(raw.slice(1));
    else if (raw.startsWith("-")) forceExcludes.push(raw.slice(1));
    else if (raw.startsWith("!")) excludes.push(raw.slice(1));
    else includes.push(raw);
  }

  const selected = new Set(
    includes.length === 0
      ? allNames
      : allNames.filter((name) =>
          includes.some((p) => matchesPattern(name, p)),
        ),
  );

  for (const name of [...selected]) {
    if (excludes.some((p) => matchesPattern(name, p))) selected.delete(name);
  }

  for (const name of allNames) {
    if (forceIncludes.some((p) => p.toLowerCase() === name.toLowerCase()))
      selected.add(name);
  }

  for (const name of allNames) {
    if (forceExcludes.some((p) => p.toLowerCase() === name.toLowerCase()))
      selected.delete(name);
  }

  return allNames.filter((name) => selected.has(name));
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

export function coalesce(value, fallback) {
  return value === undefined ? fallback : value;
}

export function shortSessionId(sessionId) {
  return String(sessionId ?? "").slice(0, 8);
}

export function buildReceiptText(callerAgent, callerSessionId, message) {
  const agentText = callerAgent ? `[${callerAgent}] agent` : "agent";

  return `Message from ${agentText} from session ${shortSessionId(callerSessionId)}:\n${message}\nOnly your final answer will be returned.`;
}

export function buildReturnText(agent, sessionId, finalAnswer) {
  const agentText = agent ? `[${agent}] agent` : "agent";

  return `Message from ${agentText} from session ${shortSessionId(sessionId)}:\n${finalAnswer}`;
}


const EXTENSION_DIR = path.join("extensions", "pi-gentic");

export function defaultAgentDir() {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent")
  );
}

export function getConfigRoots(
  cwd = process.cwd(),

  agentDir = defaultAgentDir(),
) {
  const roots = [path.join(agentDir, EXTENSION_DIR)];
  const projectRoot = findNearestProjectConfigRoot(cwd);

  if (projectRoot) roots.push(projectRoot);

  return roots;
}

function findNearestProjectConfigRoot(cwd) {
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
  diagnostics: AnyRecord[] = [],
) {
  const settings: AnyRecord = {};
  const paths = [
    path.join(agentDir, "settings.json"),
    ...ancestorDirs(cwd, ".pi", "settings.json"),
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

export function loadConfiguration(options: AnyRecord = {}) {
  const cwd = typeof options.cwd === "string" ? options.cwd : undefined;
  const agentDir =
    typeof options.agentDir === "string" ? options.agentDir : undefined;
  const roots = Array.isArray(options.roots)
    ? options.roots.filter((root): root is string => typeof root === "string")
    : getConfigRoots(cwd, agentDir);
  const settings = createDefaultSettings();
  const agentsByName = new Map<string, AnyRecord>();
  const diagnostics: AnyRecord[] = [];

  for (const root of roots) {
    const settingsPath = path.join(root, "settings.json");
    const rootSettings = readJson(settingsPath, diagnostics);

    if (rootSettings) {
      mergeRootSettings(settings, rootSettings);

      for (const definition of normalizeAgentDefinitions(
        rootSettings.agentDefinitions,
        settingsPath,
        diagnostics,
      )) {
        agentsByName.set(String(definition.name), definition);
      }
    }

    for (const definition of loadMarkdownAgents(
      path.join(root, "agents"),
      diagnostics,
    )) {
      agentsByName.set(String(definition.name), definition);
    }
  }

  const agents = [...agentsByName.values()].filter(
    (agent) => agent.disabled !== true,
  );

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
  };
}

function readJson(filePath: string, diagnostics: AnyRecord[]): AnyRecord | undefined {
  if (!existsSync(filePath)) return undefined;

  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));

    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    diagnostics.push({
      severity: "error",
      path: filePath,
      message: `Could not parse JSON: ${error instanceof Error ? error.message : String(error)}`,
    });

    return undefined;
  }
}

function mergeRootSettings(target, source) {
  if (!isRecord(source)) return;

  if (isRecord(source.agentlessSession))
    target.agentlessSession = mergeObjects(
      target.agentlessSession,
      source.agentlessSession,
    );

  if (isRecord(source.agentDefaults))
    target.agentDefaults = mergeObjects(
      target.agentDefaults,
      source.agentDefaults,
    );

  if (typeof source.defaultAgent === "string" || source.defaultAgent === null)
    target.defaultAgent = source.defaultAgent;

  if (Number.isFinite(Number(source.globalMaxSubagentDepth))) {
    target.globalMaxSubagentDepth = Math.floor(
      Number(source.globalMaxSubagentDepth),
    );
  }
}

function mergeObjects(base, patch) {
  const result = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    result[key] =
      isRecord(value) && isRecord(result[key])
        ? mergeObjects(result[key], value)
        : value;
  }

  return result;
}

function loadMarkdownAgents(dir: string, diagnostics: AnyRecord[]) {
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
    .flatMap((entry) =>
      loadMarkdownAgent(path.join(dir, entry.name), diagnostics),
    );
}

function loadMarkdownAgent(filePath: string, diagnostics: AnyRecord[]) {
  try {
    const content = readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseMarkdownDefinition(content);
    const metadata = frontmatter as AnyRecord;
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

function normalizeAgentDefinitions(value: unknown, sourcePath: string, diagnostics: AnyRecord[]) {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item, index) => {
    const definition = normalizeAgentDefinition(
      item,
      `${sourcePath}#agentDefinitions[${index}]`,
      diagnostics,
    );

    return definition ? [definition] : [];
  });
}

export function normalizeAgentDefinition(
  value,
  sourcePath = "inline",
  diagnostics: AnyRecord[] = [],
) {
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

  return removeUndefined({
    name,
    description: typeof value.description === "string" ? value.description : "",
    instructions:
      typeof value.instructions === "string" ? value.instructions : "",
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

function normalizeAgentsTool(value) {
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

function booleanOrUndefined(value) {
  return typeof value === "boolean" ? value : undefined;
}

function numberOrUndefined(value) {
  const number = Number(value);

  return Number.isFinite(number) ? Math.floor(number) : undefined;
}

function removeUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}

export function parseMarkdownDefinition(content: string): {
  frontmatter: AnyRecord;
  body: string;
} {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 3);

  if (end === -1) return { frontmatter: {}, body: content };
  const yaml = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, "");

  return { frontmatter: parseSimpleYaml(yaml), body };
}

function parseSimpleYaml(yaml: string) {
  const root: AnyRecord = {};
  const lines = yaml.split(/\r?\n/);
  let currentKey: string | undefined;
  let currentNestedKey: string | undefined;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listMatch = line.match(/^\s*-\s*(.*)$/);

    if (listMatch && currentKey) {
      if (currentNestedKey) {
        const target = ensureArraySlot(
          ensureRecordSlot(root, currentKey),
          currentNestedKey,
        );
        target.push(parseScalar(listMatch[1]));
      } else {
        ensureArraySlot(root, currentKey).push(parseScalar(listMatch[1]));
      }
      continue;
    }

    const nestedMatch = line.match(/^\s{2,}([A-Za-z][\w.-]*):\s*(.*)$/);

    if (nestedMatch && currentKey && isRecord(root[currentKey])) {
      currentNestedKey = nestedMatch[1];
      const current = ensureRecordSlot(root, currentKey);
      current[currentNestedKey] = nestedMatch[2]
        ? parseScalar(nestedMatch[2])
        : [];
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z][\w.-]*):\s*(.*)$/);

    if (!keyMatch) continue;
    currentKey = keyMatch[1];
    currentNestedKey = undefined;
    root[currentKey] = keyMatch[2] ? parseScalar(keyMatch[2]) : [];

    if (currentKey.includes(".")) {
      assignDotted(root, currentKey, root[currentKey]);
      delete root[currentKey];
      currentKey = currentKey.split(".")[0];
    }
  }

  return root;
}

function ensureRecordSlot(root: AnyRecord, key: string): AnyRecord {
  if (!isRecord(root[key])) root[key] = {};

  return root[key] as AnyRecord;
}

function ensureArraySlot(root: AnyRecord, key: string): unknown[] {
  if (!Array.isArray(root[key])) root[key] = [];

  return root[key] as unknown[];
}

function assignDotted(root: AnyRecord, key: string, value: unknown) {
  const parts = key.split(".");
  let current = root;

  for (const part of parts.slice(0, -1)) {
    current = ensureRecordSlot(current, part);
  }

  current[parts[parts.length - 1]] = value;
}

function parseScalar(value) {
  const trimmed = value.trim();

  if (trimmed === "true") return true;

  if (trimmed === "false") return false;

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => parseScalar(item))
      .filter((item) => item !== "");
  }

  return trimmed;
}

function mergePiSettings(target: AnyRecord, source: AnyRecord) {
  for (const [key, value] of Object.entries(source))
    target[key] = isRecord(value) && isRecord(target[key])
      ? mergeObjects(target[key], value)
      : value;
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
const skillCache = new Map<string, AnyRecord[]>();

export function loadAvailableSkills(options: AnyRecord = {}) {
  const cwd = path.resolve(text(options.cwd) ?? process.cwd());
  const agentDir = path.resolve(text(options.agentDir) ?? defaultAgentDir());
  const diagnostics = Array.isArray(options.diagnostics)
    ? (options.diagnostics as AnyRecord[])
    : [];
  const settings = isRecord(options.settings)
    ? options.settings
    : loadPiSettings(agentDir, cwd, diagnostics);
  const configuredRoots = strings(options.skillRoots)?.map((root) => path.resolve(root));
  const cacheKey = cacheKeyFor(cwd, agentDir, options, configuredRoots);

  if (cacheKey && skillCache.has(cacheKey)) return skillCache.get(cacheKey) ?? [];

  const roots = options.noSkills
    ? []
    : configuredRoots ?? skillRoots(cwd, agentDir, settings, diagnostics);
  const files = [
    ...roots.flatMap((root) => collectSkillFiles(root, diagnostics)),
    ...explicitSkillFiles([...refs(settings.skills), ...refs(options.skills)], cwd, agentDir, diagnostics),
  ];
  const skills = dedupeSkills(
    files.flatMap((filePath) => loadSkillEntry(filePath, diagnostics)),
    diagnostics,
  );

  if (cacheKey) skillCache.set(cacheKey, skills);
  return skills;
}

export function findAvailableSkill(name: unknown, options: AnyRecord = {}) {
  const query = String(name ?? "").toLowerCase();

  return loadAvailableSkills(options).find(
    (skill) => String(skill.name).toLowerCase() === query,
  );
}

function cacheKeyFor(
  cwd: string,
  agentDir: string,
  options: AnyRecord,
  configuredRoots?: string[],
) {
  return configuredRoots || options.noSkills || options.skills || options.settings || options.diagnostics
    ? undefined
    : `${cwd}::${agentDir}`;
}

function skillRoots(
  cwd: string,
  agentDir: string,
  settings: AnyRecord,
  diagnostics: AnyRecord[],
) {
  return uniquePaths([
    path.join(agentDir, "skills"),
    path.join(homedir(), ".agents", "skills"),
    ...ancestorDirs(cwd, ".agents", "skills"),
    ...ancestorDirs(cwd, ".pi", "skills"),
    ...packageSkillRoots(cwd, settings, diagnostics),
  ]);
}

function collectSkillFiles(root: string, diagnostics: AnyRecord[]): string[] {
  if (!existsSync(root)) return [];
  if (root.endsWith(".md")) return [root];

  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = path.join(root, entry.name);
      const skillPath = path.join(fullPath, "SKILL.md");

      if (entry.name.startsWith(".")) return [];
      if (entry.isFile() && entry.name.endsWith(".md")) return [fullPath];
      return entry.isDirectory() && existsSync(skillPath) ? [skillPath] : [];
    });
  } catch (error) {
    diagnostics.push(diag("warning", root, "Could not read skills directory", error));
    return [];
  }
}

function explicitSkillFiles(
  entries: unknown[],
  cwd: string,
  agentDir: string,
  diagnostics: AnyRecord[],
) {
  return entries.flatMap((entry) => {
    const ref = refPath(entry);
    const resolved = ref
      ? uniquePaths([
          path.isAbsolute(ref) ? ref : path.resolve(cwd, ref),
          path.resolve(agentDir, ref),
        ]).find(existsSync)
      : undefined;

    if (resolved) return skillFilesFromPath(resolved, diagnostics);
    if (ref)
      diagnostics.push({
        severity: "warning",
        path: ref,
        message: `Could not resolve configured skill "${ref}".`,
      });
    return [];
  });
}

function skillFilesFromPath(resolved: string, diagnostics: AnyRecord[]) {
  if (resolved.endsWith(".md")) return [resolved];
  const skillFile = path.join(resolved, "SKILL.md");

  return existsSync(skillFile) ? [skillFile] : collectSkillFiles(resolved, diagnostics);
}

function packageSkillRoots(
  cwd: string,
  settings: AnyRecord,
  diagnostics: AnyRecord[],
) {
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

function packageSkillRootsFromManifest(root: string, diagnostics: AnyRecord[]) {
  const manifest = readSkillJson(path.join(root, "package.json"), diagnostics);
  const declared = isRecord(manifest?.pi) ? refs(manifest.pi.skills) : [];
  const skillRoots = declared.length
    ? declared.map((entry) => resolvePackageSkillRef(entry, root))
    : [path.join(root, "skills")];

  return skillRoots.filter((item): item is string => Boolean(item && existsSync(item)));
}

function resolvePackageRoot(entry: unknown, cwd: string, diagnostics: AnyRecord[]) {
  const ref = refPath(entry);
  if (!ref) return undefined;

  const candidate = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
  if (existsSync(path.join(candidate, "package.json"))) return candidate;

  try {
    return path.dirname(createRequire(path.join(cwd, "package.json")).resolve(`${ref}/package.json`));
  } catch {
    diagnostics.push({
      severity: "warning",
      path: ref,
      message: `Could not resolve configured Pi package "${ref}".`,
    });
    return undefined;
  }
}

function resolvePackageSkillRef(entry: unknown, root: string) {
  const ref = refPath(entry);

  return ref ? (path.isAbsolute(ref) ? ref : path.resolve(root, ref)) : undefined;
}

function loadSkillEntry(filePath: string, diagnostics: AnyRecord[]) {
  try {
    const { frontmatter, body } = parseMarkdownDefinition(readFileSync(filePath, "utf8"));
    const metadata = frontmatter as AnyRecord;
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

    return [compact({
      name,
      description,
      location: filePath,
      source: text(metadata.source),
      license: text(metadata.license),
      compatibility: toStringArray(metadata.compatibility),
      metadata: isRecord(metadata.metadata) ? metadata.metadata : undefined,
      allowedTools: toolRefs(metadata["allowed-tools"] ?? metadata.allowedTools),
      disableModelInvocation:
        metadata["disable-model-invocation"] === true ||
        metadata.disableModelInvocation === true,
      instructions: body.trim(),
    })];
  } catch (error) {
    diagnostics.push(diag("warning", filePath, "Could not load skill", error));
    return [];
  }
}

function dedupeSkills(skills: AnyRecord[], diagnostics: AnyRecord[]) {
  const byName = new Map<string, AnyRecord>();

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

function readSkillJson(filePath: string, diagnostics: AnyRecord[]) {
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
    ? value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean)
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

function compact(object: AnyRecord) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
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
}) {
  const defaults = settings.agentDefaults ?? {};
  const agentless = settings.agentlessSession ?? {};
  const base = activeAgent ? defaults : agentless;
  const merged = mergePolicyObjects(base, activeAgent ?? {});
  const resolved = mergePolicyObjects(merged, overrides ?? {});
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
    maxSubagentDepth: coalesce(resolved.maxSubagentDepth, 1),
    agentsTool: mergePolicyObjects(
      defaults.agentsTool ?? {},
      mergePolicyObjects(activeAgent?.agentsTool ?? {}, overrides?.agentsTool ?? {}),
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

function mergePolicyObjects(base, patch) {
  const result = { ...(base ?? {}) };

  for (const [key, value] of Object.entries(patch ?? {})) {
    result[key] =
      isPlainObject(value) && isPlainObject(result[key])
        ? mergePolicyObjects(result[key], value)
        : value;
  }

  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertCanCreateSubagent({
  currentDepth,
  maxSubagentDepth,
  globalMaxSubagentDepth,
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

function integer(value) {
  const number = Number(value);

  return Number.isFinite(number) ? Math.floor(number) : 0;
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


const AGENT_SYSTEM_PROMPT = "@agent/SYSTEM.md";

const DELEGATION_PROMPT = "@agent/extensions/pi-gentic/DELEGATION.md";

export function buildResolvedSystemPrompt({
  baseSystemPrompt,
  config,
  policy,
  skillEntries,
}) {
  const resolvedSkillEntries = mergeSkillEntries(
    skillEntries,
    parseSkillEntries(baseSystemPrompt),
  );
  const sources = promptSources({ baseSystemPrompt, config, policy });
  const sections = [
    ...sources
      .filter((source) => source.slot === "native")
      .map((source) => source.content),
    policy.instructions,
    ...sources
      .filter((source) => source.slot !== "native")
      .map((source) => source.content),
    agentsSection(config, policy),
    namingSection(policy),
    skillsSection(resolvedSkillEntries, policy),
  ]
    .map((section) => String(section ?? "").trim())
    .filter(Boolean);

  return sections.join("\n\n");
}

export function mergeSkillEntries(
  primary: AnyRecord[] = [],
  secondary: AnyRecord[] = [],
) {
  const merged = new Map();

  for (const entry of [...primary, ...secondary]) {
    if (!entry?.name) continue;
    const current = merged.get(entry.name);

    if (current) {
      merged.set(entry.name, {
        ...entry,
        ...current,
        block: current.block ?? entry.block,
      });
      continue;
    }
    merged.set(entry.name, entry);
  }

  return [...merged.values()];
}

export function availableAgentLines(agents, allowedNames) {
  const allowed = new Set(allowedNames);
  const lines = agents
    .filter((agent) => allowed.has(agent.name))
    .map((agent) => `- ${agent.name}: ${agent.description ?? ""}`.trim());

  return lines.join("\n") || "none";
}

export function parseSkillEntries(systemPrompt) {
  const entries: AnyRecord[] = [];
  const block = String(systemPrompt ?? "").match(
    /<available_skills>[\s\S]*?<\/available_skills>/,
  )?.[0];

  if (!block) return entries;

  for (const match of block.matchAll(/<skill>[\s\S]*?<\/skill>/g)) {
    const skillBlock = match[0];
    const name = xmlValue(skillBlock, "name");

    if (name)
      entries.push({
        name,
        description: xmlValue(skillBlock, "description") ?? "",
        location: xmlValue(skillBlock, "location") ?? "",
        allowedTools: splitXmlList(xmlValue(skillBlock, "allowed-tools")),
        disableModelInvocation:
          xmlValue(skillBlock, "disable-model-invocation") === "true",
        block: skillBlock,
      });
  }

  return entries;
}

export function filterSkillPrompt(systemPrompt, skillEntries, allowedSkills) {
  const prompt = removeNativeSkillSection(systemPrompt);
  const skills = skillsSection(skillEntries, { resources: { skills: allowedSkills } });

  return [prompt.trim(), skills].filter(Boolean).join("\n\n");
}

function promptSources({ baseSystemPrompt, config, policy }) {
  const filters = Array.isArray(policy.systemPromptFiles)
    ? policy.systemPromptFiles
    : undefined;
  const sources = [
    ...nativePromptSources(baseSystemPrompt),
    ...delegationSources(config, policy),
    ...promptFileSources(config, filters),
  ].filter((source) => source.content);

  if (!filters) return sources;
  const allowed = new Set(
    applyFilterList(
      sources.map((source) => source.id),
      filters,
    ),
  );

  return sources.filter((source) => allowed.has(source.id));
}

function nativePromptSources(systemPrompt) {
  const prompt = removeNativeSkillSection(systemPrompt);
  const projectSources: AnyRecord[] = [];
  const withoutProjectInstructions = prompt.replace(
    /<project_instructions\b([^>]*)>([\s\S]*?)<\/project_instructions>/g,
    (full, attributes, body) => {
      const sourcePath =
        attributes.match(/\bpath=["']([^"']+)["']/)?.[1] ?? "AGENTS.md";
      projectSources.push({
        id: sourcePath,
        content: stripXmlTags(body).trim(),
      });

      return "";
    },
  );

  return [
    {
      id: AGENT_SYSTEM_PROMPT,
      slot: "native",
      content: stripXmlTags(withoutProjectInstructions).trim(),
    },
    ...projectSources.map((source) => ({ ...source, slot: "native" })),
  ];
}

function delegationSources(config, policy) {
  if (
    !canUseAgentsTool(policy) ||
    (policy.resources?.agents ?? []).length === 0
  )
    return [];
  return (config.roots ?? [])
    .map((root) => {
      const filePath = path.join(root, "DELEGATION.md");

      return existsSync(filePath)
        ? {
            id: DELEGATION_PROMPT,
            slot: "delegation",
            content: readFileSync(filePath, "utf8").trim(),
          }
        : undefined;
    })
    .filter(Boolean);
}

function promptFileSources(config, filters) {
  return promptFileRefs(filters)
    .map((filePath) => ({
      id: filePath,
      slot: "file",
      content: readPromptFile(filePath, config),
    }))
    .filter((source) => source.content);
}

function promptFileRefs(filters) {
  if (!Array.isArray(filters)) return [];

  return filters
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .flatMap((entry) =>
      entry.startsWith("+")
        ? [entry.slice(1)]
        : entry.startsWith("!") || entry.startsWith("-") || entry === "*"
          ? []
          : [entry],
    )
    .filter((entry) => entry && !entry.includes("*") && !entry.includes("?"));
}

function agentsSection(config, policy) {
  if (!canUseAgentsTool(policy)) return "";
  const lines = availableAgentLines(
    config.agents ?? [],
    policy.resources?.agents ?? [],
  );

  return lines === "none" ? "" : `Available agents\n${lines}`;
}

function namingSection(policy) {
  return canUseAgentsTool(policy)
    ? "When generating a session or worktree name, it must be 3 words long max."
    : "";
}

function skillsSection(skillEntries, policy) {
  const allowed = new Set(policy.resources?.skills ?? []);
  const skills = skillEntries.filter(
    (skill) => allowed.has(skill.name) && skill.disableModelInvocation !== true,
  );

  return skills.length ? renderAvailableSkillsBlock(skills) : "";
}

function canUseAgentsTool(policy) {
  return (
    (policy.resources?.tools ?? []).includes("agents") &&
    (policy.resources?.agents ?? []).length > 0
  );
}

function readPromptFile(filePath, config) {
  const resolved = resolvePromptFile(filePath, config);

  if (!resolved) return "";

  try {
    return readFileSync(resolved, "utf8").trim();
  } catch {
    return "";
  }
}

function resolvePromptFile(filePath: string, config: AnyRecord) {
  if (!filePath || typeof filePath !== "string") return undefined;
  const candidates: string[] = [];

  if (path.isAbsolute(filePath)) candidates.push(filePath);

  const roots = Array.isArray(config.roots) ? config.roots : [];

  for (const root of roots) {
    if (typeof root === "string") candidates.push(path.resolve(root, filePath));
  }
  const activeAgent = config.activeAgent;
  const sourcePath =
    isRecord(activeAgent) && typeof activeAgent.sourcePath === "string"
      ? activeAgent.sourcePath
      : undefined;

  if (sourcePath && !path.isAbsolute(filePath))
    candidates.push(
      path.resolve(path.dirname(sourcePath.split("#")[0]), filePath),
    );

  candidates.push(path.resolve(filePath));

  return candidates.find((candidate) => existsSync(candidate));
}

function removeNativeSkillSection(systemPrompt) {
  return String(systemPrompt ?? "")
    .replace(
      /\n*The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/,
      "",
    )
    .trim();
}

function stripXmlTags(text) {
  return String(text ?? "")
    .replace(
      /<\/?(?:project_context|project_instructions|active-agent|available_skills|skill|name|description|location)(?:\s+[^>]*)?>/g,
      "",
    )
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

function renderAvailableSkillsBlock(skills) {
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
    ...skills.map((skill) => renderSkillBlock(skill)),
    "</available_skills>",
  ].join("\n");
}

function renderSkillBlock(skill) {
  if (skill.block) return normalizeSkillBlock(skill.block);

  return [
    "  <skill>",
    `    <name>${escapeXml(skill.name)}</name>`,
    `    <description>${escapeXml(skill.description ?? "")}</description>`,
    skill.location ? `    <location>${escapeXml(skill.location)}</location>` : "",
    "  </skill>",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeSkillBlock(block) {
  return String(block ?? "")
    .trim()
    .split(/\r?\n/)
    .map((line) => `  ${line.trim()}`)
    .join("\n");
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function splitXmlList(value) {
  return value
    ? value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;
}

function xmlValue(block, tag) {
  return block
    .match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]
    ?.trim();
}
