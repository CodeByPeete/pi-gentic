import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { systemPromptFileKey, systemPromptFilePath } from "../settings.js";
import type { UnknownRecord } from "../shared/values.js";
import { errorMessage as getErrorMessage, isRecord, stringArray } from "../shared/values.js";
import { applyCapabilityFilter } from "../sessions/policy.js";

export function buildResolvedSystemPrompt({
  baseSystemPrompt,
  config,
  policy,
}: {
  baseSystemPrompt: string;
  config: UnknownRecord;
  policy: UnknownRecord;
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

export function availableAgentLines(agents: UnknownRecord[], allowedNames: string[]) {
  const allowed = new Set(allowedNames);
  const lines = agents
    .filter((agent) => allowed.has(String(agent.name)))
    .map((agent) => `- ${String(agent.name)}: ${String(agent.description ?? "")}`.trim());

  return lines.join("\n") || "none";
}

function delegationSections(config: UnknownRecord, policy: UnknownRecord) {
  if (!canUseAgentsTool(policy)) return [];

  return configurationRoots(config)
    .map((root) => readPromptFile(path.join(root, "DELEGATION.md"), config))
    .filter((content) => content.length > 0);
}

function promptFileSections(config: UnknownRecord, filters: unknown) {
  return promptFileRefs(filters)
    .map((filePath) => readPromptFile(filePath, config, configuredPromptFileRoot(config, filePath)))
    .filter((content) => content.length > 0);
}

function promptFileRefs(filters: unknown) {
  const rules = stringArray(filters).map((rule) => rule.trim());
  const candidates = new Map<string, string>();

  for (const rule of rules) {
    const filePath = systemPromptFilePath(rule);

    if (filePath) candidates.set(systemPromptFileKey(filePath), filePath);
  }

  const selected = new Set(applyCapabilityFilter([...candidates.values()], rules).map(systemPromptFileKey));

  return [...candidates].flatMap(([key, filePath]) => (selected.has(key) ? [filePath] : []));
}

function configuredPromptFileRoot(config: UnknownRecord, filePath: string) {
  const roots = config.systemPromptFileRoots;

  if (!isRecord(roots)) return undefined;
  const activeAgent = isRecord(config.activeAgent) ? config.activeAgent : undefined;
  const agentName = typeof activeAgent?.name === "string" ? activeAgent.name.toLowerCase() : undefined;
  const agentRoots = agentName && roots.agents instanceof Map ? roots.agents.get(agentName) : undefined;
  const agentRoot = promptFileRoot(agentRoots, filePath);

  return agentRoot ?? promptFileRoot(activeAgent ? roots.agentDefaults : roots.agentlessSession, filePath);
}

function promptFileRoot(roots: unknown, filePath: string) {
  const root = roots instanceof Map ? roots.get(systemPromptFileKey(filePath)) : undefined;

  return typeof root === "string" ? root : undefined;
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

function readPromptFile(filePath: string, config: UnknownRecord, root?: string) {
  const resolved = resolvePromptFile(filePath, config, root);

  if (!resolved) return "";

  try {
    return readFileSync(resolved, "utf8").trim();
  } catch (error) {
    recordPromptDiagnostic(config, resolved, "Could not read prompt file", error);
    return "";
  }
}

function resolvePromptFile(filePath: string, config: UnknownRecord, sourceRoot?: string) {
  if (filePath.length === 0) return undefined;
  const roots = configurationRoots(config);
  const candidates = path.isAbsolute(filePath)
    ? [filePath]
    : sourceRoot
      ? [path.resolve(sourceRoot, filePath)]
      : roots.map((root) => path.resolve(root, filePath));

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
