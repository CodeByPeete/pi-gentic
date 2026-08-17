import { loadConfiguration } from "../infrastructure/configuration/agents.js";
import { loadAvailableSkills } from "../infrastructure/configuration/skills.js";
import type { UnknownRecord } from "../shared/types.js";
import { recordArray, shortestUniqueSessionId, stringArray, stringValue } from "../shared/value.js";

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
  const skills = suggestionContext.skills?.length
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
  const descriptors = [
    {
      flag: "model",
      values: modelCompletionValues(recordArray(options.models)),
    },
    { flag: "thinking", values: THINKING_LEVELS.map(completionValue) },
    { flag: "theme", values: stringArray(options.themes).map(completionValue) },
    { flag: "tools", values: stringArray(options.tools).map(completionValue), list: true },
    {
      flag: "agents",
      values: recordArray(options.agents).map((agent) => completionValue(agent.name)),
      list: true,
    },
    { flag: "skills", values: stringArray(options.skills).map(completionValue), list: true },
    {
      flag: "system-prompt-files",
      values: stringArray(options.systemPromptFiles).map(completionValue),
      list: true,
    },
    { flag: "max-subagent-depth", values: ["1", "2", "3", "4", "5", "6"].map(completionValue) },
    { flag: "cwd", values: [".agentfiles/worktrees/"].map(completionValue) },
    { flag: "worktree", values: [suggestedWorktreeName(prefix)].map(completionValue) },
    { flag: "repo", values: ["."].map(completionValue) },
  ];

  for (const descriptor of descriptors) {
    const completion = flagValueCompletion(prefix, descriptor.flag);

    if (!completion) continue;

    const list = descriptor.list
      ? listValueCompletion(descriptor.values, completion.token)
      : { query: completion.token, values: descriptor.values };

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
