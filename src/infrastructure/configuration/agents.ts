import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { ancestorPaths } from "../../shared/path.js";
import type { UnknownRecord } from "../../shared/types.js";
import { isRecord, omitUndefined as removeUndefined, stringList as toStringArray } from "../../shared/value.js";

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
const EXTENSION_DIR = path.join("extensions", "pi-gentic");
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

export function defaultAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

function getConfigRoots(cwd = process.cwd(), agentDir = defaultAgentDir(), projectTrusted = false) {
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
    ...(projectTrusted ? ancestorPaths(cwd, ".pi", "settings.json") : []),
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

function dedupePaths(paths: string[]) {
  return [...new Set(paths.filter(Boolean).map((item) => path.resolve(String(item))))];
}
