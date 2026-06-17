/**
 * User-facing command language for pi-gentic.
 *
 * This file keeps slash-command parsing and completion together so every
 * surface uses the same flag rules and session id suggestions.
 */
import { loadConfiguration } from "./config.js";
import { isRecord, shortSessionId } from "./core.js";

const SEND_VALUE_FLAGS = new Set([
  "agent",
  "session",
  "cwd",
  "worktree",
  "model",
  "thinking",
  "theme",
  "tools",
  "agents",
  "skills",
  "system-prompt-files",
  "max-subagent-depth",
]);

const SEND_BOOLEAN_FLAGS = ["fork", "bg", "fg", "no-invoke"];

const SEND_FLAGS = [
  "agent",
  "session",
  "fork",
  "bg",
  "fg",
  "no-invoke",
  "cwd",
  "worktree",
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

/** Splits a slash command like a shell, while preserving quoted message text. */
export function tokenizeCommandLine(input: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined = "";
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += quote ? unescapeQuotedCharacter(char) : char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";

  if (current) tokens.push(current);

  return tokens;
}

function unescapeQuotedCharacter(char) {
  if (char === "n") return "\n";

  if (char === "r") return "\r";

  if (char === "t") return "\t";

  return char;
}

function readFlagValue(tokens, index, inlineValue, optional = false) {
  if (inlineValue !== undefined)
    return { value: inlineValue, nextIndex: index };
  const next = tokens[index + 1];

  if (next === undefined || next === "" || (optional && next.startsWith("--")))
    return { value: undefined, nextIndex: index };
  return { value: next, nextIndex: index + 1 };
}

export function parseAgentCommand(input) {
  const tokens = tokenizeCommandLine(input.trim());
  let sessionId;
  const words = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const match = token.match(/^--session(?:=(.*))?$/);

    if (match) {
      const result = readFlagValue(tokens, index, match[1]);

      if (result.value) sessionId = result.value;
      index = result.nextIndex;
      continue;
    }
    words.push(token);
  }

  return { agent: words[0], sessionId };
}

/** Converts send command text into the same fields accepted by the agents tool. */
export function parseSendCommand(input: string) {
  const tokens = tokenizeCommandLine(input.trim());
  const messageTokens: string[] = [];
  const result: AnyRecord = {
    message: "",
    agent: undefined,
    sessionId: undefined,
    fork: false,
    async: undefined,
    cwd: undefined,
    invokeMeLater: undefined,
    overrides: undefined,
    worktree: undefined,
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const keyValue = token.match(/^--([A-Za-z][\w-]*)(?:=(.*))?$/);

    if (!keyValue) {
      messageTokens.push(token);
      continue;
    }

    const key = keyValue[1];
    const inlineValue = keyValue[2];

    if (SEND_VALUE_FLAGS.has(key)) {
      const value = readFlagValue(tokens, index, inlineValue, key === "worktree");

      applySendFlagValue(result, key, value.value);
      index = value.nextIndex;
      continue;
    }

    if (key === "fork") {
      result.fork = true;
      continue;
    }

    if (key === "bg") {
      result.async = true;
      continue;
    }

    if (key === "fg") {
      result.async = false;
      continue;
    }

    if (key === "no-invoke") {
      result.invokeMeLater = false;
      continue;
    }
    messageTokens.push(token);
  }

  result.message = messageTokens.join(" ").trim();

  return result;
}

function applySendFlagValue(result: AnyRecord, key: string, value: unknown) {
  const text = typeof value === "string" ? value : undefined;

  if (key === "agent" && text) result.agent = text;
  else if (key === "session" && text) result.sessionId = text;
  else if (key === "cwd" && text) result.cwd = text;
  else if (key === "worktree") result.worktree = text ?? "";
  else if (key === "model" && text) setOverride(result, "model", text);
  else if (key === "thinking" && text) setOverride(result, "thinking", text);
  else if (key === "theme" && text) setOverride(result, "theme", text);
  else if (key === "tools" && text) setOverride(result, "tools", splitList(text));
  else if (key === "agents" && text) setOverride(result, "agents", splitList(text));
  else if (key === "skills" && text) setOverride(result, "skills", splitList(text));
  else if (key === "system-prompt-files" && text)
    setOverride(result, "systemPromptFiles", splitList(text));
  else if (key === "max-subagent-depth" && text) {
    const number = Number(text);

    if (Number.isFinite(number))
      setOverride(result, "maxSubagentDepth", Math.floor(number));
  }
}

function setOverride(result: AnyRecord, key: string, value: unknown) {
  result.overrides = { ...(isRecord(result.overrides) ? result.overrides : {}) };
  result.overrides[key] = value;
}

function splitList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeToolInput(input) {
  if (!isRecord(input)) throw new Error("Tool input must be a JSON object.");

  if (typeof input.action !== "string" || !input.action.trim())
    throw new Error('Missing required field "action".');
  const action = input.action.trim();

  return { ...input, action };
}

export function completeAgents(prefix, activeAgentName, cwd = process.cwd()) {
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

/** Suggests only the values that make sense at the cursor position. */
type CompletionOptions =
  | string
  | {
      cwd?: string;
      sessions?: AnyRecord[];
      currentSessionId?: string;
      agents?: AnyRecord[];
      models?: AnyRecord[];
      tools?: string[];
      skills?: string[];
      themes?: string[];
      systemPromptFiles?: string[];
    };

export function completeSend(prefix: string, options: CompletionOptions = {}) {
  const cwd =
    typeof options === "string" ? options : (options.cwd ?? process.cwd());
  const sessions =
    typeof options === "object" && Array.isArray(options.sessions)
      ? options.sessions
      : [];
  const currentSessionId =
    typeof options === "object" ? options.currentSessionId : undefined;
  const suggestionContext = typeof options === "object" ? options : {};
  const token = prefix.split(/\s/).at(-1) ?? "";
  const replaceToken = (value: string) =>
    `${prefix.slice(0, prefix.length - token.length)}${value}`;
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
    return completeSessions(sessionValue.token, sessions, currentSessionId).map(
      (session) => ({ ...session, value: sessionValue.replace(session.value) }),
    );
  }

  if (token.startsWith("--")) {
    return SEND_FLAGS.filter((flag) => flag.startsWith(token)).map((flag) => ({
      value: replaceToken(flag),
      label: flag,
    }));
  }

  return null;
}

export function isCompletingSendSession(prefix: string) {
  return Boolean(flagValueCompletion(prefix, "session"));
}

function completeSendFlagValue(prefix: string, options: AnyRecord) {
  const descriptors = [
    {
      flag: "model",
      values: modelCompletionValues(recordArray(options.models)),
    },
    { flag: "thinking", values: THINKING_LEVELS.map(simpleValue) },
    { flag: "theme", values: stringArray(options.themes).map(simpleValue) },
    { flag: "tools", values: stringArray(options.tools).map(filterValue), list: true },
    {
      flag: "agents",
      values: recordArray(options.agents).map((agent) => filterValue(agent.name)),
      list: true,
    },
    { flag: "skills", values: stringArray(options.skills).map(filterValue), list: true },
    {
      flag: "system-prompt-files",
      values: stringArray(options.systemPromptFiles).map(filterValue),
      list: true,
    },
    { flag: "max-subagent-depth", values: ["1", "2", "3", "4", "5", "6"].map(simpleValue) },
    { flag: "cwd", values: [".agentfiles/worktrees/"].map(simpleValue) },
    { flag: "worktree", values: [suggestedWorktreeName(prefix)].map(simpleValue) },
  ];

  for (const descriptor of descriptors) {
    const completion = flagValueCompletion(prefix, descriptor.flag);

    if (!completion) continue;

    const list = descriptor.list
      ? listValueCompletion(descriptor.values, completion.token)
      : { query: completion.token, values: descriptor.values };

    return list.values
      .filter(
        (item) =>
          !list.query ||
          [item.value, item.label, item.description].some((text) =>
            String(text ?? "")
              .toLowerCase()
              .includes(list.query.toLowerCase()),
          ),
      )
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

function recordArray(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function listValueCompletion(values, token: string) {
  const comma = token.lastIndexOf(",");
  const prefix = comma === -1 ? "" : token.slice(0, comma + 1);
  const query = comma === -1 ? token : token.slice(comma + 1);

  return {
    query,
    values: values.map((item) => ({ ...item, value: `${prefix}${item.value}` })),
  };
}

function modelCompletionValues(models: AnyRecord[] = []) {
  return models.map((model) => {
    const provider = stringValue(model.provider);
    const id = stringValue(model.id) ?? stringValue(model.value);
    const value = provider && id ? `${provider}/${id}` : id;

    return {
      value,
      label: value,
      description: stringValue(model.label) ?? stringValue(model.name),
    };
  }).filter((item) => item.value);
}

function simpleValue(value: string) {
  return { value, label: value };
}

function filterValue(value: unknown) {
  const text = String(value ?? "");

  return { value: text, label: text };
}

function completeRecords(token: string, records: AnyRecord[], key: string) {
  const query = token.trim().toLowerCase();

  return records
    .map((record) => ({
      value: String(record[key] ?? ""),
      label: String(record[key] ?? ""),
      description: stringValue(record.description),
    }))
    .filter((item) => item.value)
    .filter(
      (item) =>
        !query ||
        [item.value, item.label, item.description].some((text) =>
          String(text ?? "")
            .toLowerCase()
            .includes(query),
        ),
    );
}

function flagValueCompletion(prefix: string, flag: string) {
  const inline = prefix.match(new RegExp(`(^|\\s)--${flag}=([^\\s]*)$`));

  if (inline) {
    const token = inline[2] ?? "";

    return {
      token,
      replace: (value: string) =>
        `${prefix.slice(0, prefix.length - token.length)}${value}`,
    };
  }

  const spaced = prefix.match(new RegExp(`(^|\\s)--${flag}\\s+([^\\s]*)$`));

  if (!spaced) return undefined;
  const token = spaced[2] ?? "";

  return {
    token,
    replace: (value: string) =>
      `${prefix.slice(0, prefix.length - token.length)}${value}`,
  };
}

function completeSessions(
  token: string,
  sessions: AnyRecord[],
  currentSessionId?: string,
) {
  const query = token.trim().toLowerCase();

  return sessions
    .filter((session) => sessionIdentifier(session) !== currentSessionId)
    .map((session) => sessionCompletion(session))
    .filter(
      (session) =>
        !query ||
        [session.value, session.label, session.description].some((text) =>
          String(text ?? "")
            .toLowerCase()
            .includes(query),
        ),
    );
}

function sessionCompletion(session: AnyRecord) {
  const id = sessionIdentifier(session);
  const visibleId = shortSessionId(id);
  const agentName = stringValue(session.agentName);
  const agent = agentName ? `[${agentName}] ` : "";
  const message =
    stringValue(session.lastMessage) ??
    stringValue(session.firstMessage) ??
    stringValue(session.name) ??
    "Untitled session";

  return {
    value: visibleId,
    label: visibleId,
    description: `${agent}${message}`.trim(),
  };
}

function sessionIdentifier(session: AnyRecord) {
  return stringValue(session.sessionId) ?? stringValue(session.id);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
