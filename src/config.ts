/**
 * Configuration loading for pi-gentic.
 *
 * Global and project roots are read in order, with later roots replacing
 * earlier agent definitions. Markdown agents and inline settings end up in the
 * same normalized shape before policy resolution sees them.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isRecord, toStringArray } from "./core.js";

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

/** Loads settings, agents, diagnostics, and config roots for one working directory. */
export function loadPiSettings(agentDir = defaultAgentDir()) {
  return readJson(path.join(agentDir, "settings.json"), []) ?? {};
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

/** Turns user-authored JSON or frontmatter into the canonical agent shape. */
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

/** Parses the small frontmatter subset used by agent and skill markdown files. */
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

const skillCatalogCache = new Map();

/** Discovers skill metadata without loading the full skill instructions. */
export function loadAvailableSkills(options: AnyRecord = {}) {
  const cwd = path.resolve(
    typeof options.cwd === "string" ? options.cwd : process.cwd(),
  );
  const agentDir = path.resolve(
    typeof options.agentDir === "string" ? options.agentDir : defaultAgentDir(),
  );
  const configuredSkillRoots = Array.isArray(options.skillRoots)
    ? options.skillRoots.filter((root): root is string => typeof root === "string")
    : undefined;
  const roots =
    configuredSkillRoots?.map((root) => path.resolve(root)) ??
    skillRoots(cwd, agentDir);
  const cacheKey = configuredSkillRoots ? undefined : `${cwd}::${agentDir}`;

  if (cacheKey && skillCatalogCache.has(cacheKey))
    return skillCatalogCache.get(cacheKey);
  const skills = [
    ...new Map(
      roots
        .flatMap(collectMarkdownFiles)
        .map(loadSkillEntry)
        .filter(Boolean)
        .map((entry) => [entry.name, entry]),
    ).values(),
  ];

  if (cacheKey) skillCatalogCache.set(cacheKey, skills);

  return skills;
}

function skillRoots(cwd: string, agentDir: string) {
  return dedupePaths([
    path.join(agentDir, "skills"),
    path.join(homedir(), ".agents", "skills"),
    ...ancestorDirs(cwd, ".agents", "skills"),
    ...ancestorDirs(cwd, ".pi", "skills"),
  ]);
}

function ancestorDirs(cwd: string, ...parts: string[]) {
  const dirs: string[] = [];

  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    dirs.unshift(path.join(current, ...parts));

    if (path.dirname(current) === current) return dirs;
  }
}

function dedupePaths(paths: string[]) {
  return [...new Set(paths.map((item) => path.resolve(item)))];
}

function collectMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: import("node:fs").Dirent[] = [];

  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) files.push(...collectMarkdownFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(fullPath);
  }

  return files;
}

function loadSkillEntry(filePath: string) {
  try {
    const content = readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseMarkdownDefinition(content);
    const metadata = frontmatter as AnyRecord;
    const name = typeof metadata.name === "string" ? metadata.name.trim() : "";

    if (!name) return undefined;
    const description =
      typeof metadata.description === "string"
        ? metadata.description.trim()
        : firstParagraph(body);

    return { name, description, location: filePath };
  } catch {
    return undefined;
  }
}

function firstParagraph(text) {
  return String(text ?? "")
    .split(/\r?\n\r?\n/, 1)[0]
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}
