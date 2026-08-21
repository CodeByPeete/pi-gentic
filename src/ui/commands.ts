import { AGENT_CYCLE_SHORTCUT } from "../agents/activation.js";
import type { Orchestrator } from "../delegation/send.js";
import type { PiApi, PiContext } from "../pi/types.js";
import { loadPiSettings } from "../settings.js";
import type { UnknownRecord } from "../shared/values.js";
import { errorMessage, firstText, isRecord, shortSessionId, stringList } from "../shared/values.js";
import {
  completeAgents,
  completeSend,
  completeSkill,
  createCompletionContext,
  isCompletingSendSession,
  listCompletionSessions,
} from "./completions.js";

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

export function installTerminalCommands(
  pi: PiApi,
  orchestrator: Orchestrator,
  completionContext: ReturnType<typeof createCompletionContext>,
  publishCard: (text: string, details: UnknownRecord) => void,
) {
  const showError = (error: unknown, kind = "error") => {
    const message = errorMessage(error);
    publishCard(message, orchestrator.cardDetails(kind, "error", { error: message }));
  };

  pi.registerShortcut(AGENT_CYCLE_SHORTCUT, {
    description: "Cycle pi-gentic active agent",
    handler: async (ctx) => {
      completionContext.capture(ctx);
      try {
        const result = await orchestrator.cycleAgent(ctx);
        publishCard(result.text, result.details);
      } catch (error) {
        showError(error);
      }
    },
  });

  pi.registerCommand("agent", {
    description: "Set, clear, or show the active pi-gentic agent",
    getArgumentCompletions: (prefix) => completeAgents(prefix, orchestrator.currentAgentName),
    handler: async (args, ctx) => {
      completionContext.capture(ctx);
      const parsed = parseAgentCommand(args);

      if (!parsed.agent) {
        const active = orchestrator.getActiveAgent(ctx);
        ctx.ui.notify(
          active ? `Active agent: ${active.name}\n${active.description ?? ""}` : "No active agent.",
          "info",
        );
        return;
      }

      try {
        if (parsed.sessionId) {
          const config = orchestrator.load(ctx);
          const runtime = await orchestrator.getOrOpenSession(ctx, parsed.sessionId);

          if (parsed.agent === "clear") {
            runtime.session.sessionManager.appendCustomEntry("pi-gentic:state", { agentName: undefined });
            ctx.ui.notify(
              `Cleared active agent in session ${shortSessionId(runtime.session.sessionManager.getSessionId())}.`,
              "info",
            );
            return;
          }
          await orchestrator.loadAgentIntoSession(runtime.session, parsed.agent, undefined, config, ctx);
          ctx.ui.notify(
            `Loaded ${parsed.agent} in session ${shortSessionId(runtime.session.sessionManager.getSessionId())}.`,
            "info",
          );
          return;
        }

        const result = await orchestrator.loadAgent(ctx, parsed.agent);
        publishCard(result.text, result.details);
      } catch (error) {
        showError(error);
      }
    },
  });

  pi.registerCommand("skill", {
    description: "Manually invoke a Pi skill: /skill <name> [request]",
    getArgumentCompletions: (prefix) => completeSkill(prefix, completionContext.current()),
    handler: async (args, ctx) => {
      completionContext.capture(ctx);
      const parsed = parseSkillCommand(args);

      if (!parsed.name) {
        ctx.ui.notify?.("Usage: /skill <name> [request]", "warning");
        return;
      }

      await invokeSkillCommand(pi, orchestrator, parsed.name, parsed.message, ctx);
    },
  });

  pi.registerCommand("send", {
    description: "Send a message to a pi-gentic child or target session",
    getArgumentCompletions: async (prefix) => {
      const snapshot = completionContext.current();

      if (!isCompletingSendSession(prefix)) return completeSend(prefix, snapshot);
      const sessions = await listCompletionSessions(snapshot);

      return completeSend(prefix, {
        cwd: snapshot.cwd,
        sessions,
        currentSessionId: snapshot.currentSessionId,
      });
    },
    handler: async (args, ctx) => {
      completionContext.capture(ctx);
      const parsed = parseSendCommand(args);

      if (typeof parsed.message !== "string" || !parsed.message.trim()) {
        ctx.ui.notify(
          "Usage: /send <message> [--agent <agentName>] [--session <sessionId>] [--fork] [--bg|--fg] [--no-invoke] [--cwd <dir>] [--worktree [branch]] [--repo <dir>] [override flags]",
          "warning",
        );
        return;
      }

      try {
        let showedProgress = false;
        const result = await orchestrator.send(
          ctx,
          { ...parsed, message: parsed.message },
          {
            awaitCompletion: false,
            onUpdate: (update: unknown) => {
              if (showedProgress) return;
              showedProgress = true;
              const result = isRecord(update) ? update : {};
              publishCard(
                firstText(result.content) ?? "Sending message...",
                isRecord(result.details) ? result.details : {},
              );
            },
          },
        );

        if (!showedProgress)
          publishCard(
            typeof result.text === "string" ? result.text : String(result.text ?? ""),
            isRecord(result.details) ? result.details : {},
          );
      } catch (error) {
        showError(error, "send");
      }
    },
  });
}

async function invokeSkillCommand(
  pi: PiApi,
  orchestrator: Orchestrator,
  skillName: string,
  message: string,
  ctx: PiContext,
) {
  if (!skillCommandsEnabled(ctx)) {
    ctx.ui.notify?.("Pi skill commands are disabled by settings.", "warning");
    return;
  }
  const nativeSkillName = orchestrator
    .applyPolicySnapshot(ctx)
    .policy.resources.skills.find((name) => name.toLowerCase() === skillName.toLowerCase());

  if (!nativeSkillName) {
    ctx.ui.notify?.(`Unavailable Pi skill "${skillName}".`, "warning");
    return;
  }

  await pi.sendUserMessage(`/skill:${nativeSkillName}${message ? ` ${message}` : ""}`, {
    expandPromptTemplates: true,
  });
}

function skillCommandsEnabled(ctx: PiContext) {
  return (
    loadPiSettings(undefined, ctx.cwd ?? process.cwd(), [], ctx.isProjectTrusted?.() === true).enableSkillCommands !==
    false
  );
}
