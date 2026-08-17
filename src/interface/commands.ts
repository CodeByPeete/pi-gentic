import { agentsActionName, normalizeAgentsToolInputSync } from "../domain/agents-tool.js";
import type { UnknownRecord } from "../shared/types.js";
import { isRecord } from "../shared/value.js";

const SEND_VALUE_FLAGS = new Set([
  "agent",
  "session",
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
]);

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

function unescapeQuotedCharacter(char: string) {
  if (char === "n") return "\n";

  if (char === "r") return "\r";

  if (char === "t") return "\t";

  return char;
}

function readFlagValue(tokens: ReadonlyArray<string>, index: number, inlineValue: string | undefined) {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const next = tokens[index + 1];

  if (next === undefined || next === "" || next.startsWith("--")) return { value: undefined, nextIndex: index };
  return { value: next, nextIndex: index + 1 };
}

export function parseAgentCommand(input: string) {
  const tokens = tokenizeCommandLine(input.trim());
  let sessionId;
  const words: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) continue;
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

export function parseSkillCommand(input: string) {
  const tokens = tokenizeCommandLine(input.trim());
  const name = tokens[0] ?? "";
  const message = tokens.slice(1).join(" ").trim();

  return { name, message };
}

export function buildManualSkillMessage(skill: UnknownRecord, message = "") {
  const allowedTools = Array.isArray(skill.allowedTools)
    ? skill.allowedTools.filter((tool) => typeof tool === "string")
    : [];
  const parts = [
    `Use the Pi skill "${skill.name}" for this request.`,
    skill.description ? `Description: ${skill.description}` : "",
    skill.location ? `Location: ${skill.location}` : "",
    allowedTools.length ? `Allowed tools: ${allowedTools.join(", ")}` : "",
    skill.instructions ? `<skill_instructions>\n${skill.instructions}\n</skill_instructions>` : "",
    message ? `Request:\n${message}` : "Proceed with this skill.",
  ].filter(Boolean);

  return parts.join("\n\n");
}

export function parseSendCommand(input: string) {
  const tokens = tokenizeCommandLine(input.trim());
  const messageTokens: string[] = [];
  const result: UnknownRecord = {
    message: "",
    agent: undefined,
    sessionId: undefined,
    fork: false,
    async: undefined,
    cwd: undefined,
    invokeMeLater: undefined,
    overrides: undefined,
    worktree: undefined,
    repo: undefined,
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) continue;
    const keyValue = token.match(/^--([A-Za-z][\w-]*)(?:=(.*))?$/);

    if (!keyValue) {
      messageTokens.push(token);
      continue;
    }

    const key = keyValue[1];
    const inlineValue = keyValue[2];

    if (key === undefined) {
      messageTokens.push(token);
      continue;
    }

    if (SEND_VALUE_FLAGS.has(key)) {
      const value = readFlagValue(tokens, index, inlineValue);

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

function applySendFlagValue(result: UnknownRecord, key: string, value: unknown) {
  const text = typeof value === "string" ? value : undefined;

  if (key === "agent" && text) result.agent = text;
  else if (key === "session" && text) result.sessionId = text;
  else if (key === "cwd" && text) result.cwd = text;
  else if (key === "worktree") result.worktree = text ?? "";
  else if (key === "repo" && text) result.repo = text;
  else if (key === "model" && text) setOverride(result, "model", text);
  else if (key === "thinking" && text) setOverride(result, "thinking", text);
  else if (key === "theme" && text) setOverride(result, "theme", text);
  else if (key === "tools" && text) setOverride(result, "tools", splitList(text));
  else if (key === "agents" && text) setOverride(result, "agents", splitList(text));
  else if (key === "skills" && text) setOverride(result, "skills", splitList(text));
  else if (key === "system-prompt-files" && text) setOverride(result, "systemPromptFiles", splitList(text));
  else if (key === "max-subagent-depth" && text) {
    const number = Number(text);

    if (Number.isFinite(number)) setOverride(result, "maxSubagentDepth", Math.floor(number));
  }
}

function setOverride(result: UnknownRecord, key: string, value: unknown) {
  const overrides = {
    ...(isRecord(result.overrides) ? result.overrides : {}),
    [key]: value,
  };

  result.overrides = overrides;
}

function splitList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeToolInput(input: unknown) {
  const normalized = normalizeAgentsToolInputSync(input);

  return { ...normalized, action: agentsActionName(normalized) };
}
