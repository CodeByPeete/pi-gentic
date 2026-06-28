/**
 * Prompt construction for Pi sessions.
 *
 * Policy decides which agents, skills, and prompt files are visible. This file
 * turns that resolved policy into Pi-compatible system prompt text.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { applyFilterList, isRecord } from "./core.js";

const AGENT_SYSTEM_PROMPT = "@agent/SYSTEM.md";

const DELEGATION_PROMPT = "@agent/extensions/pi-gentic/DELEGATION.md";

/** Produces the final prompt Pi will use before an agent run starts. */
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

/** Extracts native Pi skill metadata so policy can filter it before display. */
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
