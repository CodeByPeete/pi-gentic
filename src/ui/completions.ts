import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadAvailableSkills, systemPromptSkillEntries } from "../agents/skills.js";
import type { PiApi, PiContext } from "../pi/types.js";
import {
  enrichSessionSummaries,
  findSessionSummary,
  buildSessionTree,
  sessionCompletionScope,
} from "../sessions/catalog.js";
import { enabledModelPatterns, loadConfiguration } from "../settings.js";
import { recoverDiagnostic, reportRuntimeDiagnostic } from "../shared/diagnostics.js";
import type { UnknownRecord } from "../shared/values.js";
import {
  isRecord,
  recordArray,
  recordValue,
  shortestUniqueSessionId,
  stringArray,
  stringValue,
} from "../shared/values.js";

const SEND_FLAGS = [
  "agent",
  "session",
  "fork",
  "bg",
  "fg",
  "no-invoke",
  "cwd",
  "worktree",
  "repo",
  "model",
  "thinking",
  "theme",
  "tools",
  "agents",
  "skills",
  "system-prompt-files",
  "max-subagent-depth",
].map((flag) => `--${flag}`);

const THINKING_LEVELS = ["low", "medium", "high"];

type CompletionItem = {
  value: string;
  label: string;
  description?: string;
};

export function completeAgents(prefix: string, activeAgentName: string | undefined, cwd = process.cwd()) {
  const config = loadConfiguration({ cwd });
  const query = prefix.trim().toLowerCase();

  return config.agents
    .filter((agent) => agent.name !== activeAgentName)
    .filter((agent) => !query || agent.name.toLowerCase().includes(query))
    .map((agent) => ({
      value: agent.name,
      label: agent.name,
      description: agent.description,
    }));
}

type CompletionOptions =
  | string
  | {
      cwd?: string;
      sessions?: UnknownRecord[];
      currentSessionId?: string;
      agents?: UnknownRecord[];
      models?: UnknownRecord[];
      tools?: string[];
      skills?: string[];
      commands?: UnknownRecord[];
      themes?: string[];
      systemPromptFiles?: string[];
    };

export function completeSkill(prefix: string, options: CompletionOptions = {}) {
  const cwd = typeof options === "string" ? options : (options.cwd ?? process.cwd());
  const suggestionContext = typeof options === "object" ? options : {};
  const token = prefix.split(/\s/).at(-1) ?? "";
  const replaceToken = (value: string) => `${prefix.slice(0, prefix.length - token.length)}${value}`;
  const skills = Array.isArray(suggestionContext.skills)
    ? suggestionContext.skills
    : loadAvailableSkills({ cwd }).map((skill) => skill.name);
  const query = token.toLowerCase();

  return skills
    .filter((name) => !query || name.toLowerCase().includes(query))
    .map((name) => ({ value: replaceToken(name), label: name }));
}

export function completeSend(prefix: string, options: CompletionOptions = {}) {
  const cwd = typeof options === "string" ? options : (options.cwd ?? process.cwd());
  const sessions = typeof options === "object" && Array.isArray(options.sessions) ? options.sessions : [];
  const currentSessionId = typeof options === "object" ? options.currentSessionId : undefined;
  const suggestionContext = typeof options === "object" ? options : {};
  const token = prefix.split(/\s/).at(-1) ?? "";
  const replaceToken = (value: string) => `${prefix.slice(0, prefix.length - token.length)}${value}`;
  const agentValue = flagValueCompletion(prefix, "agent");

  if (agentValue) {
    const agents = suggestionContext.agents?.length
      ? completeRecords(agentValue.token, suggestionContext.agents, "name")
      : completeAgents(agentValue.token, undefined, cwd);

    return agents.map((agent) => ({
      ...agent,
      value: agentValue.replace(agent.value),
    }));
  }

  const valueCompletion = completeSendFlagValue(prefix, suggestionContext);

  if (valueCompletion) return valueCompletion;

  const sessionValue = flagValueCompletion(prefix, "session");

  if (sessionValue) {
    return completeSessions(sessionValue.token, sessions, currentSessionId).map((session) => ({
      ...session,
      value: sessionValue.replace(session.value ?? ""),
    }));
  }

  if (token.startsWith("--")) {
    return SEND_FLAGS.filter((flag) => flag.startsWith(token)).map((flag) => ({
      value: replaceToken(flag),
      label: flag,
    }));
  }

  const commandCompletions = completeSlashSendCommand(token, replaceToken, suggestionContext);

  return commandCompletions ?? null;
}

export function isCompletingSendSession(prefix: string) {
  return Boolean(flagValueCompletion(prefix, "session"));
}

function completeSlashSendCommand(token: string, replaceToken: (value: string) => string, options: UnknownRecord) {
  if (!token.startsWith("/")) return undefined;
  const query = token.toLowerCase();

  return sendSlashCommandValues(options)
    .filter((command) => completionItemMatches(command, query))
    .map((command) => ({ ...command, value: replaceToken(command.value) }));
}

function sendSlashCommandValues(options: UnknownRecord) {
  const commands = recordArray(options.commands)
    .filter((command) => stringValue(command.name))
    .map((command) => commandCompletion(String(command.name), command));
  const hasSkillCommands = commands.some((command) => command.value.startsWith("/skill:"));
  const skillFallbacks = hasSkillCommands
    ? []
    : stringArray(options.skills).map((name) => commandCompletion(`skill:${name}`));
  const byValue = new Map();

  for (const command of [...commands, ...skillFallbacks]) {
    if (command.value && !byValue.has(command.value)) byValue.set(command.value, command);
  }

  return [...byValue.values()];
}

function commandCompletion(name: string, command: UnknownRecord = {}) {
  const value = `/${name}`;

  return {
    value,
    label: value,
    description: stringValue(command.description),
  };
}

function completionItemMatches(item: UnknownRecord, query: string) {
  const normalized = query.toLowerCase();
  return (
    !normalized ||
    [item.value, item.label, item.description].some((text) =>
      String(text ?? "")
        .toLowerCase()
        .includes(normalized),
    )
  );
}

function completeSendFlagValue(prefix: string, options: UnknownRecord) {
  const descriptors: Array<[string, CompletionItem[], boolean?]> = [
    ["model", modelCompletionValues(recordArray(options.models))],
    ["thinking", THINKING_LEVELS.map(completionValue)],
    ["theme", stringArray(options.themes).map(completionValue)],
    ["tools", stringArray(options.tools).map(completionValue), true],
    ["agents", recordArray(options.agents).map((agent) => completionValue(agent.name)), true],
    ["skills", stringArray(options.skills).map(completionValue), true],
    ["system-prompt-files", stringArray(options.systemPromptFiles).map(completionValue), true],
    ["max-subagent-depth", ["1", "2", "3", "4", "5", "6"].map(completionValue)],
    ["cwd", [completionValue(".agentfiles/worktrees/")]],
    ["worktree", [completionValue(suggestedWorktreeName(prefix))]],
    ["repo", [completionValue(".")]],
  ];

  for (const [flag, values, completesList] of descriptors) {
    const completion = flagValueCompletion(prefix, flag);

    if (!completion) continue;

    const list = completesList ? listValueCompletion(values, completion.token) : { query: completion.token, values };

    return list.values
      .filter((item) => completionItemMatches(item, list.query))
      .map((item) => ({ ...item, value: completion.replace(item.value) }));
  }

  return undefined;
}

function suggestedWorktreeName(prefix: string) {
  const message = prefix.split(/\s--worktree(?:=|\s)?/)[0] ?? "agent-worktree";
  const slug = message
    .replace(/^\/send\s+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return slug || "agent-worktree";
}

function listValueCompletion(values: ReadonlyArray<CompletionItem>, token: string) {
  const comma = token.lastIndexOf(",");
  const prefix = comma === -1 ? "" : token.slice(0, comma + 1);
  const query = comma === -1 ? token : token.slice(comma + 1);

  return {
    query,
    values: values.map((item) => ({ ...item, value: `${prefix}${item.value}` })),
  };
}

function modelCompletionValues(models: UnknownRecord[] = []): CompletionItem[] {
  return models.flatMap((model) => {
    const provider = stringValue(model.provider);
    const id = stringValue(model.id) ?? stringValue(model.value);
    const value = provider && id ? `${provider}/${id}` : id;

    return value
      ? [
          {
            value,
            label: value,
            description: stringValue(model.label) ?? stringValue(model.name),
          },
        ]
      : [];
  });
}

function completionValue(value: unknown): CompletionItem {
  const text = String(value ?? "");
  return { value: text, label: text };
}

function completeRecords(token: string, records: UnknownRecord[], key: string) {
  const query = token.trim().toLowerCase();

  return records
    .map((record) => ({
      value: String(record[key] ?? ""),
      label: String(record[key] ?? ""),
      description: stringValue(record.description),
    }))
    .filter((item) => item.value && completionItemMatches(item, query));
}

function flagValueCompletion(prefix: string, flag: string) {
  const inline = prefix.match(new RegExp(`(^|\\s)--${flag}=([^\\s]*)$`));

  if (inline) {
    const token = inline[2] ?? "";

    return {
      token,
      replace: (value: string) => `${prefix.slice(0, prefix.length - token.length)}${value}`,
    };
  }

  const spaced = prefix.match(new RegExp(`(^|\\s)--${flag}\\s+([^\\s]*)$`));

  if (!spaced) return undefined;
  const token = spaced[2] ?? "";

  return {
    token,
    replace: (value: string) => `${prefix.slice(0, prefix.length - token.length)}${value}`,
  };
}

function completeSessions(token: string, sessions: UnknownRecord[], currentSessionId?: string) {
  const query = token.trim().toLowerCase();
  const sessionIds = sessions.map(sessionIdentifier).filter((id): id is string => Boolean(id));

  return sessions
    .filter((session) => sessionIdentifier(session) !== currentSessionId)
    .map((session) => sessionCompletion(session, sessionIds))
    .filter((session) => completionItemMatches(session, query));
}

function sessionCompletion(session: UnknownRecord, sessionIds: string[]) {
  const id = sessionIdentifier(session) ?? "";
  const visibleId = shortestUniqueSessionId(id, sessionIds);
  const agentName = stringValue(session.agentName);
  const agent = agentName ? `[${agentName}] ` : "";
  const message =
    stringValue(session.lastMessage) ??
    stringValue(session.firstMessage) ??
    stringValue(session.name) ??
    "Untitled session";

  return {
    value: id,
    label: visibleId,
    description: `${agent}${message}`.trim(),
  };
}

function sessionIdentifier(session: UnknownRecord) {
  return stringValue(session.sessionId) ?? stringValue(session.id);
}

type CompletionSnapshot = {
  cwd: string;
  sessionDir?: string;
  currentSessionId?: string;
  currentSessionPath?: string;
  agents: UnknownRecord[];
  models: UnknownRecord[];
  tools: string[];
  skills: string[];
  commands: UnknownRecord[];
  themes: string[];
  systemPromptFiles: string[];
};

export function createCompletionContext(
  pi: PiApi,
  options: {
    onCapture?: (snapshot: UnknownRecord, ctx?: PiContext) => void;
    resolveSkills?: (ctx: PiContext) => string[];
  } = {},
) {
  let snapshot: CompletionSnapshot = {
    cwd: process.cwd(),
    agents: [],
    models: [],
    tools: [],
    skills: [],
    commands: [],
    themes: [],
    systemPromptFiles: [],
  };

  return {
    capture(ctx: PiContext | undefined) {
      if (!ctx) return snapshot;
      const cwd = typeof ctx.cwd === "string" ? ctx.cwd : snapshot.cwd;
      const projectTrusted = ctx.isProjectTrusted?.() === true;
      const config = loadConfiguration({ cwd, projectTrusted });
      const nativeSkills = systemPromptSkillEntries(ctx);
      snapshot = {
        cwd,
        sessionDir: ctx.sessionManager?.getSessionDir?.() ?? snapshot.sessionDir,
        currentSessionId: ctx.sessionManager?.getSessionId?.() ?? snapshot.currentSessionId,
        currentSessionPath: ctx.sessionManager?.getSessionFile?.() ?? snapshot.currentSessionPath,
        agents: config.agents,
        models: scopedModelSuggestions(ctx),
        tools: safeToolNames(pi),
        skills:
          options.resolveSkills?.(ctx) ??
          (nativeSkills.length > 0 ? nativeSkills : loadAvailableSkills({ cwd, projectTrusted })).map(
            (skill) => skill.name,
          ),
        commands: safeCommands(pi),
        themes: themeSuggestions(config),
        systemPromptFiles: systemPromptFileSuggestions(config),
      };
      options.onCapture?.(snapshot, ctx);

      return snapshot;
    },
    current() {
      return snapshot;
    },
  };
}

export async function listCompletionSessions({
  cwd,
  sessionDir,
  currentSessionId,
  currentSessionPath,
}: {
  cwd: string;
  sessionDir?: string;
  currentSessionId?: string;
  currentSessionPath?: string;
}) {
  try {
    const persisted = await listCompletionSessionSources(cwd, sessionDir);
    const current =
      findSessionSummary(persisted, {
        id: currentSessionId,
        sessionId: currentSessionId,
        path: currentSessionPath,
      }) ??
      (currentSessionId || currentSessionPath
        ? {
            id: currentSessionId,
            sessionId: currentSessionId,
            path: currentSessionPath,
          }
        : undefined);
    const scoped = sessionCompletionScope(buildSessionTree(current, persisted), current, {
      rx: 4,
      ry: 4,
    });

    return enrichSessionSummaries(scoped, 20);
  } catch (error) {
    reportRuntimeDiagnostic("completion-sessions", error);
    return [];
  }
}

async function listCompletionSessionSources(cwd: string, sessionDir?: string) {
  const persisted = await SessionManager.list(cwd, sessionDir);

  return persisted.flatMap((session) => (isRecord(session) ? [session] : []));
}

function scopedModelSuggestions(ctx: PiContext | undefined) {
  const patterns = enabledModelPatterns() ?? [];
  const registry = ctx?.modelRegistry;
  const available = safeAvailableModels(registry);

  if (patterns.length === 0) return available;

  return patterns.map((pattern) => {
    const [provider, id] = String(pattern)
      .split(/\/(.*)/)
      .filter(Boolean);
    const match = provider && id ? registry?.find?.(provider, id) : undefined;

    return recordValue(match ?? { provider, id: id ?? pattern, label: pattern });
  });
}

function available<T>(scope: string, read: () => T[]) {
  return recoverDiagnostic(scope, read, () => []);
}

function safeAvailableModels(modelRegistry: unknown): UnknownRecord[] {
  return available("available-models", () =>
    isRecord(modelRegistry) && typeof modelRegistry.getAvailable === "function"
      ? recordArray(modelRegistry.getAvailable())
      : [],
  );
}

function safeToolNames(pi: PiApi) {
  return available("available-tools", () => pi.getAllTools().map((tool) => tool.name));
}

function safeCommands(pi: PiApi): UnknownRecord[] {
  return available("available-commands", () =>
    (pi.getCommands?.() ?? []).map(({ name, description }) => ({ name, description })),
  );
}

function systemPromptFileSuggestions(config: ReturnType<typeof loadConfiguration>) {
  const settings = recordValue(config.settings);
  const agentless = recordValue(settings.agentlessSession);
  const defaults = recordValue(settings.agentDefaults);
  const files = [
    ...stringArray(agentless.systemPromptFiles),
    ...stringArray(defaults.systemPromptFiles),
    ...config.agents.flatMap((agent: UnknownRecord) => stringArray(agent.systemPromptFiles)),
  ];

  return [...new Set(files)];
}

function themeSuggestions(config: ReturnType<typeof loadConfiguration>) {
  const settings = recordValue(config.settings);
  const themes = [settings.theme, ...config.agents.map((agent) => agent.theme)].filter(
    (theme): theme is string => typeof theme === "string" && Boolean(theme),
  );

  return [...new Set(themes)];
}
