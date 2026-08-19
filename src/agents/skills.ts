import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { PiContext } from "../pi/types.js";
import { ancestorPaths, uniquePaths } from "../shared/values.js";
import type { UnknownRecord } from "../shared/values.js";
import { isRecord, omitUndefined as compact, stringValue as text } from "../shared/values.js";
import {
  configurationDiagnostic,
  defaultAgentDir,
  loadPiSettings,
  parseMarkdownDefinition,
  readJsonObject,
} from "../settings.js";

export interface SkillDefinition extends UnknownRecord {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly allowedTools?: string[];
  readonly disableModelInvocation: boolean;
  readonly instructions: string;
}

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

  const diagnosticPaths = new Set<string>();
  diagnostics.push(
    ...loaded.diagnostics
      .filter(
        (diagnostic) =>
          diagnostic.type === "collision" ||
          !diagnostic.path ||
          (!diagnosticPaths.has(diagnostic.path) && Boolean(diagnosticPaths.add(diagnostic.path))),
      )
      .map((diagnostic) =>
        configurationDiagnostic(
          diagnostic.type === "error" ? "error" : "warning",
          diagnostic.path ?? "",
          diagnostic.message,
        ),
      ),
  );

  return loaded.skills.flatMap((skill) => loadSkillEntry(skill, diagnostics));
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
    if (ref) diagnostics.push(configurationDiagnostic("warning", ref, `Could not resolve configured skill "${ref}".`));
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
  const manifest = readJsonObject(path.join(root, "package.json"), diagnostics, "warning");
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
    diagnostics.push(configurationDiagnostic("debug", "", `Could not resolve skill package ${packageName}`, error));
    return undefined;
  }
}

function resolvePackageSkillRef(entry: unknown, root: string) {
  const ref = refPath(entry);

  return ref ? (path.isAbsolute(ref) ? ref : path.resolve(root, ref)) : undefined;
}

function loadSkillEntry(
  skill: { name: string; description: string; filePath: string; disableModelInvocation: boolean },
  diagnostics: UnknownRecord[],
): SkillDefinition[] {
  try {
    const { frontmatter, body } = parseMarkdownDefinition(readFileSync(skill.filePath, "utf8"));
    return [
      compact<SkillDefinition>({
        name: skill.name,
        description: skill.description,
        location: skill.filePath,
        allowedTools: toolRefs(frontmatter["allowed-tools"] ?? frontmatter.allowedTools),
        disableModelInvocation: skill.disableModelInvocation,
        instructions: body.trim(),
      }),
    ];
  } catch (error) {
    diagnostics.push(configurationDiagnostic("warning", skill.filePath, "Could not load skill", error));
    return [];
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

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}
