import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { PiContext } from "../pi/types.js";
import { ancestorPaths } from "../../shared/path.js";
import type { UnknownRecord } from "../../shared/types.js";
import {
  errorMessage as getErrorMessage,
  isRecord,
  omitUndefined as compact,
  stringList as toStringArray,
} from "../../shared/value.js";
import { defaultAgentDir, loadPiSettings, parseMarkdownDefinition, type SkillDefinition } from "./agents.js";

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
          ...ancestorPaths(cwd, ".agents", "skills"),
          ...ancestorPaths(cwd, ".pi", "skills"),
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

function diag(severity: string, filePath: string, message: string, error: unknown) {
  return {
    severity,
    path: filePath,
    message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
  };
}
