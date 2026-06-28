/** Pi skill discovery, validation, and lookup. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { isRecord, toStringArray } from "./core.js";
import { defaultAgentDir, loadPiSettings, parseMarkdownDefinition } from "./config.js";

const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const cache = new Map<string, AnyRecord[]>();

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

  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey) ?? [];

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

  if (cacheKey) cache.set(cacheKey, skills);
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
  const manifest = readJson(path.join(root, "package.json"), diagnostics);
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

function readJson(filePath: string, diagnostics: AnyRecord[]) {
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

function ancestorDirs(cwd: string, ...parts: string[]) {
  const dirs: string[] = [];
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    dirs.unshift(path.join(current, ...parts));
    if (path.dirname(current) === current) return dirs;
  }
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
