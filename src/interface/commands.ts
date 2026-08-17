import type { UnknownRecord } from "../shared/types.js";
import { isRecord, stringList } from "../shared/value.js";

type SendFlag = (result: UnknownRecord, value?: string) => void;

const field =
  (name: string): SendFlag =>
  (result, value) => {
    if (value) result[name] = value;
  };
const override =
  (name: string, transform: (value: string) => unknown = (value) => value): SendFlag =>
  (result, value) => {
    if (value) setOverride(result, name, transform(value));
  };
const SEND_VALUE_FLAGS: Record<string, SendFlag> = {
  agent: field("agent"),
  session: field("sessionId"),
  cwd: field("cwd"),
  repo: field("repo"),
  worktree: (result, value) => {
    result.worktree = value ?? "";
  },
  model: override("model"),
  thinking: override("thinking"),
  theme: override("theme"),
  tools: override("tools", stringList),
  agents: override("agents", stringList),
  skills: override("skills", stringList),
  "system-prompt-files": override("systemPromptFiles", stringList),
  "max-subagent-depth": (result, value) => {
    const number = Number(value);
    if (value && Number.isFinite(number)) setOverride(result, "maxSubagentDepth", Math.floor(number));
  },
};
const SEND_SWITCH_FLAGS: Record<string, [string, boolean]> = {
  fork: ["fork", true],
  bg: ["async", true],
  fg: ["async", false],
  "no-invoke": ["invokeMeLater", false],
};

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

    const valueFlag = SEND_VALUE_FLAGS[key];
    if (valueFlag) {
      const { value, nextIndex } = readFlagValue(tokens, index, inlineValue);
      valueFlag(result, value);
      index = nextIndex;
      continue;
    }
    const switchFlag = SEND_SWITCH_FLAGS[key];
    if (switchFlag) {
      result[switchFlag[0]] = switchFlag[1];
      continue;
    }
    messageTokens.push(token);
  }

  result.message = messageTokens.join(" ").trim();

  return result;
}

function setOverride(result: UnknownRecord, key: string, value: unknown) {
  const overrides = {
    ...(isRecord(result.overrides) ? result.overrides : {}),
    [key]: value,
  };

  result.overrides = overrides;
}
