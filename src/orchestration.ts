import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  activeAgentName,
  appendActiveState,
  assertAvailableAgent,
  assertCanCreateSubagent,
  buildReceiptText,
  buildResolvedSystemPrompt,
  buildReturnText,
  chooseBoolean,
  configuredDefaultAgent,
  filterAvailableAgents,
  formatDuration,
  getActiveState,
  getErrorMessage,
  loadAvailableSkills,
  loadConfiguration,
  mergeSkillEntries,
  parseIntegerRadius,
  parseSkillEntries,
  resolveSessionPolicy,
  shortSessionId,
  shouldApplyDefaultAgent,
  nextAgentName,
} from "./catalog.js";
import {
  abortAgentCall,
  activeVisibleContext,
  activeVisibleSession,
  applyInheritedModel,
  createLiveRuntime,
  findRuntimeSession,
  getRuntimeSession,
  listRuntimeSessions,
  persistSessionImmediately,
  pruneRuntimeSessions,
  registerAgentCall,
  resolveModelFromRegistry,
  setRuntimeSession,
  unregisterLiveRuntime,
} from "./pi-host.js";
import {
  assertDifferentSession,
  assignTreeDepths,
  buildSessionTree,
  cachedPersistedSessions,
  currentSessionSummary,
  enrichSessionSummaries,
  listSessionSummariesFast,
  resolveCurrentSessionDepth,
  resolveSessionReference,
  sessionDiscoveryScope,
  withRuntimeState,
} from "./sessions.js";
import { setAgentLabel, setLiveCardDetails } from "./ui.js";


export function abortActor(ctx) {
  const agentName = getActiveState(ctx.sessionManager).agentName;

  return agentName ? `[${agentName}] agent` : "caller session";
}

export function shouldDeferSendCompletion({
  async,
  awaitCompletion,
}: AnyRecord = {}) {
  return async === true || awaitCompletion === false;
}

export function resolveReturnDelivery(options: AnyRecord = {}) {
  return shouldDeferSendCompletion(options)
    ? { kind: "callerMessage", queue: "steer" }
    : { kind: "toolResult" };
}

export function sendPendingText({
  async,
  agentName,
  sessionId,
  message,
  details,
}) {
  return async === true
    ? sendConfirmationText(agentName, sessionId, message, {
        queued: details?.status === "queued",
      })
    : sendStatusText(details);
}

export function sendConfirmationText(
  agentName: unknown,
  sessionId: unknown,
  message: string,
  options: AnyRecord = {},
) {
  const target = agentName ? `[${agentName}] agent` : "agent";
  const action = options.queued ? "Queued message for" : "Sent message to";
  const timing = options.queued
    ? "The agent is already working and will read this message when ready."
    : "The agent will return with a full answer once he's done.";

  return `${action} ${target} in session ${shortSessionId(sessionId)}.\nMessage: ${message}\n${timing} Do not wait for it to return, and do not duplicate the delegated work yourself.`;
}

export function sendStatusText(details: AnyRecord = {}) {
  if (details.status === "done")
    return `Agent ${details.agentName ?? ""} answered.`
      .replace(/\s+/g, " ")
      .trim();

  if (details.status === "queued")
    return `Queued message for ${details.agentName ?? "agent"}.`;

  if (details.status === "stopped")
    return details.error ?? "Agent stopped before answering.";

  if (details.status === "error") return details.error ?? "Agent call failed.";

  return `Sending message to ${details.agentName ?? "agent"}...`;
}

export function deliverSendContextToCaller({
  pi,
  ctx,
  target,
  message,
  async,
  fork,
}) {
  if (ctx.isIdle?.() === false) return;
  const sessionId = target.session.sessionManager.getSessionId();
  const content = [
    "pi-gentic sent a message to another session.",
    `Target agent: ${target.agentName ?? "agentless"}`,
    `Target session: ${sessionId}`,
    `Async: ${async === true}`,
    `Fork: ${fork === true}`,
    `Message: ${message}`,
  ].join("\n");

  try {
    pi.sendMessage(
      {
        customType: "pi-gentic:send-context",
        content,
        display: false,
        details: {
          kind: "sendContext",
          agentName: target.agentName,
          sessionId,
          message,
        },
      },
      { triggerTurn: false },
    );
  } catch {
  }
}

export async function deliverReturnToCaller({
  pi,
  ctx,
  callerSessionId,
  callerSessionManager,
  text,
  invoke,
  persist,
  invokeInactiveCaller,
  visibleSession,
  queue,
}) {
  const liveDelivery = await deliverToLiveCaller({
    pi,
    ctx,
    callerSessionId,
    text,
    invoke,
    visibleSession,
    queue,
  });

  if (liveDelivery.delivered) return liveDelivery.mode;

  if (invoke && invokeInactiveCaller) {
    await invokeInactiveCaller(text);

    return "background";
  }

  persistReturnForCaller({ callerSessionManager, text, invoke, persist });

  return "persisted";
}

export async function deliverToLiveCaller({
  pi,
  ctx,
  callerSessionId,
  text,
  invoke,
  visibleSession,
  queue,
}) {
  const liveSession = liveCallerSession(ctx, callerSessionId, visibleSession);

  try {
    if (liveSession) {
      if (
        (invoke || liveSession.isStreaming === true) &&
        typeof liveSession.sendUserMessage === "function"
      ) {
        await liveSession.sendUserMessage(
          text,
          liveSession.isStreaming === true
            ? { deliverAs: queue }
            : sendUserMessageOptions(ctx, queue),
        );

        return { delivered: true, mode: "live" };
      }

      if (typeof liveSession.sendCustomMessage === "function") {
        await liveSession.sendCustomMessage(returnContextMessage(text), {
          triggerTurn: false,
        });

        return { delivered: true, mode: "live" };
      }
    }

    if (!contextStillActive(ctx, callerSessionId)) return { delivered: false };

    if (invoke) pi.sendUserMessage(text, sendUserMessageOptions(ctx, queue));
    else pi.sendMessage(returnContextMessage(text), customMessageOptions(ctx, queue));

    return { delivered: true, mode: "live" };
  } catch {
    return { delivered: false };
  }
}

function liveCallerSession(
  ctx: PiContext,
  callerSessionId: string | undefined,
  visibleSession: AnyRecord | undefined,
) {
  const registered = callerSessionId ? getRuntimeSession(callerSessionId)?.session : undefined;

  if (registered) return registered;

  if (!visibleSession) return undefined;
  const visibleSessionId = visibleSession.sessionManager?.getSessionId?.();

  return !callerSessionId ||
    visibleSessionId === callerSessionId ||
    (!visibleSessionId && contextStillActive(ctx, callerSessionId))
    ? visibleSession
    : undefined;
}

function returnContextMessage(text: string) {
  return {
    customType: "pi-gentic:return-context",
    content: text,
    display: true,
    details: { kind: "returnContext" },
  };
}

export function persistReturnForCaller({
  callerSessionManager,
  text,
  invoke,
  persist,
}) {
  if (invoke)
    callerSessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
  else
    callerSessionManager.appendCustomMessageEntry?.(
      "pi-gentic:return-context",
      text,
      true,
      { kind: "returnContext" },
    );

  persist?.(callerSessionManager);
}

function waitForSessionTurnEnd(session: AnyRecord, signal?: AbortSignal) {
  if (session.isStreaming !== true) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let done = false;
    let unsubscribe: (() => void) | undefined;
    const interval = setInterval(() => {
      if (session.isStreaming !== true) finish();
    }, 250);
    const abort = () => finish(new Error("Agent call aborted."));
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearInterval(interval);
      unsubscribe?.();
      signal?.removeEventListener?.("abort", abort);
      if (error) reject(error);
      else resolve();
    };

    interval.unref?.();
    signal?.addEventListener?.("abort", abort, { once: true });
    unsubscribe = session.subscribe?.((event) => {
      if (event?.type === "agent_end") finish();
    });
  });
}

export function sendUserMessageOptions(ctx, queue = "followUp") {
  return ctx.isIdle?.() === false ? { deliverAs: queue } : undefined;
}

function customMessageOptions(ctx, queue = "followUp") {
  return {
    triggerTurn: false,
    ...sendUserMessageOptions(ctx, queue),
  };
}

export function persistSynchronousToolCard(
  ctx: PiContext,
  input: AnyRecord,
  result: AnyRecord,
  persist?: (sessionManager: PiSessionManager) => void,
) {
  if (input.action !== "send") return;
  if (["running", "queued"].includes(String(result.details?.status ?? "")))
    return;

  ctx.sessionManager.appendCustomMessageEntry?.(
    "pi-gentic:card",
    result.text,
    true,
    result.details,
  );
  persist?.(ctx.sessionManager);
}

export async function displayTargetAnswerIfVisible({
  ctx,
  target,
  targetSessionId,
  text,
}) {
  if (!contextStillActive(ctx, targetSessionId)) return false;

  const message = {
    customType: "pi-gentic:return-context",
    content: `Final answer from this session:\n${text}`,
    display: true,
    details: { kind: "targetAnswer", sessionId: targetSessionId },
  };

  try {
    if (typeof target.session.sendCustomMessage === "function") {
      await target.session.sendCustomMessage(message, { triggerTurn: false });

      return true;
    }

    target.session.sessionManager.appendCustomMessageEntry?.(
      message.customType,
      message.content,
      message.display,
      message.details,
    );

    return true;
  } catch {
    return false;
  }
}

export function contextStillActive(ctx, callerSessionId?: string) {
  try {
    void ctx.cwd;
    const activeSessionId = ctx.sessionManager.getSessionId();

    return !callerSessionId || activeSessionId === callerSessionId;
  } catch {
    return false;
  }
}

export function createSessionActivityMonitor(baseDetails, publish) {
  const state = {
    ...baseDetails,
    activities: [],
    updatedAt: baseDetails.updatedAt ?? Date.now(),
  };
  const publishState = (status = state.status, updates = {}) => {
    Object.assign(state, updates, { status });

    return publish({ ...state, activities: [...state.activities] });
  };
  const touch = () => {
    state.updatedAt = Date.now();
  };

  return {
    get activities() {
      return state.activities;
    },
    observe(event) {
      const activity = eventToActivity(event);

      if (!activity) return;
      touch();
      upsertActivity(state.activities, activity);
      publishState("running");
    },
    finish({ activities }) {
      state.activities = mergeActivities(state.activities, activities);

      return publishState("done", {
        completedAt: Date.now(),
        updatedAt: state.updatedAt,
      });
    },
    stop(status: string, updates: AnyRecord = {}) {
      state.activities = mergeActivities(
        state.activities,
        updates.activities ?? [],
      );

      return publishState(status, {
        completedAt: Date.now(),
        updatedAt: state.updatedAt,
        ...updates,
      });
    },
    fail(error) {
      return publishState("error", {
        completedAt: Date.now(),
        error: getErrorMessage(error),
      });
    },
  };
}

export function collectSessionActivities(session) {
  return session.agent.state.messages.flatMap((message) => {
    if (message.role === "assistant")
      return assistantMessageActivities(message);

    if (message.role === "toolResult")
      return [
        {
          id: message.toolCallId,
          type: "tool",
          name: message.toolName,
          summary: summarizeValue(message.content),
          status: message.isError ? "error" : "done",
        },
      ];

    return [];
  });
}

export function mergeActivities(...activityLists: unknown[][]) {
  const merged: AnyRecord[] = [];

  for (const activity of activityLists.flat().filter(Boolean))
    upsertActivity(merged, activity);

  return merged;
}

export function lastRuntimeActivities(runtime) {
  return runtime.lastActivities?.length
    ? runtime.lastActivities
    : collectSessionActivities(runtime.session);
}

export function latestActivityLines(runtime, count = 3) {
  return lastRuntimeActivities(runtime)
    .slice(-count)
    .map(formatActivityLine)
    .filter(Boolean);
}

export function formatActivityLine(activity) {
  if (!activity) return undefined;

  if (activity.type === "assistant")
    return `assistant ${truncateInline(activity.text, 160)}`;
  const status = activity.status ? ` (${activity.status})` : "";

  return `[${activity.name ?? activity.type}] ${truncateInline(activity.summary ?? activity.text ?? "", 160)}${status}`.trim();
}

function eventToActivity(event) {
  if (!event || typeof event !== "object") return undefined;

  if (event.type === "tool_execution_start")
    return {
      id: event.toolCallId,
      type: "tool",
      name: event.toolName,
      summary: summarizeValue(event.args),
      status: "running",
    };

  if (event.type === "tool_execution_update")
    return {
      id: event.toolCallId,
      type: "tool",
      name: event.toolName,
      summary: summarizeValue(event.partialResult ?? event.args),
      status: "running",
    };

  if (event.type === "tool_execution_end")
    return {
      id: event.toolCallId,
      type: "tool",
      name: event.toolName,
      summary: summarizeValue(event.result),
      status: event.isError ? "error" : "done",
    };

  if (event.type === "message_update" && event.message?.role === "assistant")
    return assistantActivity(event.message);

  if (event.type === "message_end" && event.message?.role === "assistant")
    return assistantActivity(event.message);
  return undefined;
}

function assistantMessageActivities(message) {
  const activities = [];
  const text = messageText(message);

  if (text)
    activities.push({
      id: "assistant",
      type: "assistant",
      text,
      status:
        message.stopReason === "error"
          ? "error"
          : message.stopReason === "aborted"
            ? "aborted"
            : undefined,
    });
  else if (message.stopReason === "aborted")
    activities.push({
      id: "assistant",
      type: "assistant",
      text: message.errorMessage || "Operation aborted",
      status: "aborted",
    });
  else if (message.stopReason === "error")
    activities.push({
      id: "assistant",
      type: "assistant",
      text: message.errorMessage || "Unknown error",
      status: "error",
    });

  if (Array.isArray(message.content)) {
    activities.push(
      ...message.content
        .filter((part) => part.type === "toolCall")
        .map((part) => ({
          id: part.id,
          type: "tool",
          name: part.name,
          summary: summarizeValue(part.arguments ?? {}),
        })),
    );
  }

  return activities;
}

function assistantActivity(message) {
  const text = messageText(message);

  return text ? { id: "assistant", type: "assistant", text } : undefined;
}

function upsertActivity(activities, activity) {
  const key = activity.id ?? `${activity.type}:${activity.name ?? ""}`;
  const index = activities.findIndex(
    (item) => (item.id ?? `${item.type}:${item.name ?? ""}`) === key,
  );

  if (index === -1) activities.push(activity);
  else activities[index] = { ...activities[index], ...activity };
}

function messageText(message) {
  if (!message) return "";

  if (typeof message.content === "string") return message.content;

  if (!Array.isArray(message.content)) return "";

  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n");
}

function summarizeValue(value) {
  if (Array.isArray(value))
    return value
      .map((item) => item.text ?? item.data ?? JSON.stringify(item))
      .join(" ")
      .slice(0, 240);

  if (value && typeof value === "object") {
    if (Array.isArray(value.content)) return summarizeValue(value.content);

    if (typeof value.text === "string") return value.text.slice(0, 240);

    return JSON.stringify(value).slice(0, 240);
  }

  return String(value ?? "").slice(0, 240);
}

function truncateInline(text, length) {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > length
    ? `${normalized.slice(0, Math.max(0, length - 1))}…`
    : normalized;
}

export function sessionRunOutcome(
  runtime: AnyRecord,
  { request, error }: AnyRecord = {},
) {
  const session = runtime.session as {
    agent: { state: { messages: unknown[] } };
  };
  const assistant = lastAssistantMessage(session.agent.state.messages);
  const text = assistantText(assistant);

  if (
    text &&
    assistant?.stopReason !== "aborted" &&
    assistant?.stopReason !== "error"
  )
    return { status: "done", text };

  if (assistant?.stopReason === "aborted")
    return {
      status: "aborted",
      text: sessionOutcomeText(runtime, "aborted", { request }),
    };

  if (assistant?.stopReason === "error")
    return {
      status: "error",
      text: sessionOutcomeText(runtime, "error", {
        request,
        error: assistant.errorMessage,
      }),
    };

  if (error)
    return {
      status: "error",
      text: sessionOutcomeText(runtime, "error", {
        request,
        error: getErrorMessage(error),
      }),
    };

  return {
    status: "stopped",
    text: sessionOutcomeText(runtime, "stopped", { request }),
  };
}

export function sessionOutcomeText(
  runtime: AnyRecord,
  kind: string,
  { request, error }: AnyRecord = {},
) {
  const session = runtime.session as { sessionManager: PiSessionManager };
  const sessionId = shortSessionId(session.sessionManager.getSessionId?.());
  const agent = runtime.agentName ? ` [${runtime.agentName}]` : "";
  const lastAbort = runtime.lastAbort as AnyRecord | undefined;
  const actor =
    lastAbort?.actor ??
    (kind === "aborted" ? "user in that session" : undefined);
  const activityLines = latestActivityLines(runtime).map((line) => `- ${line}`);
  const details = [
    kind === "aborted"
      ? `Session ${sessionId}${agent} was aborted while handling your request.`
      : undefined,
    kind === "aborted" ? `Aborted by: ${actor}.` : undefined,
    kind === "error"
      ? `Session ${sessionId}${agent} failed while handling your request.`
      : undefined,
    kind === "error" ? `Error: ${error || "Unknown error"}` : undefined,
    kind === "stopped"
      ? `Session ${sessionId}${agent} stopped before returning a final answer.`
      : undefined,
    request ? `Request: ${request}` : undefined,
    activityLines.length
      ? `Last activity:\n${activityLines.join("\n")}`
      : undefined,
  ].filter(Boolean);

  return details.join("\n");
}

function lastAssistantMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (message.role === "assistant") return message;
  }

  return undefined;
}

function assistantText(message) {
  if (!message) return "";
  const text = Array.isArray(message.content)
    ? message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    : message.content;

  return String(text ?? "").trim();
}

export function sessionStatus(runtime) {
  const now = Date.now();
  const running = runtime.session.isStreaming === true;
  runtime.streamingStartedAt = running
    ? (runtime.runStartedAt ??
      runtime.streamingStartedAt ??
      runtime.lastActivityAt ??
      runtime.createdAt ??
      new Date(now).toISOString())
    : undefined;
  const lastActivityAt = runtime.lastActivityAt ?? runtime.createdAt;
  const inactiveMs = elapsedMs(now, lastActivityAt);
  const runningMs = running
    ? elapsedMs(now, runtime.runStartedAt ?? runtime.streamingStartedAt)
    : undefined;
  const pendingMessages = Number(runtime.session.pendingMessageCount ?? 0);
  const status = {
    sessionId: runtime.session.sessionManager.getSessionId(),
    agentName: runtime.agentName,
    running,
    state: running ? "running" : pendingMessages > 0 ? "queued" : "idle",
    pendingMessages,
    pendingText:
      pendingMessages === 1
        ? "1 queued message"
        : `${pendingMessages} queued messages`,
    inactiveMs,
    inactiveText: formatDuration(inactiveMs),
    runningMs: runningMs ?? null,
    runningText: runningMs === undefined ? null : formatDuration(runningMs),
    lastActivities: lastRuntimeActivities(runtime).slice(-3),
  };

  return { ...status, text: formatSessionStatus(status) };
}

export function formatSessionStatus(status) {
  const title = `Session ${shortSessionId(status.sessionId)}${status.agentName ? ` [${status.agentName}]` : ""}`;
  const lines = [
    title,
    `State: ${status.state ?? (status.running ? "running" : "idle")}`,
    status.runningText ? `Running for: ${status.runningText}` : undefined,
    `Last activity: ${status.inactiveText ?? formatDuration(status.inactiveMs ?? 0)} ago`,
    Number(status.pendingMessages ?? 0) > 0
      ? `Queued messages: ${status.pendingMessages}`
      : undefined,
  ];
  const activities = Array.isArray(status.lastActivities)
    ? status.lastActivities
    : [];

  if (activities.length > 0) {
    lines.push("Recent activity:");
    lines.push(
      ...activities.map((activity) => `- ${formatStatusActivity(activity)}`),
    );
  }

  return lines.filter(Boolean).join("\n");
}

function elapsedMs(now, value) {
  const time =
    typeof value === "number"
      ? value
      : value
        ? new Date(value).getTime()
        : undefined;

  return Number.isFinite(time) ? Math.max(0, now - time) : 0;
}

function formatStatusActivity(activity) {
  if (!activity || typeof activity !== "object") return String(activity ?? "");

  if (activity.type === "tool")
    return `[${activity.name ?? "tool"}] ${activity.status ?? ""}`.trim();
  return String(
    activity.text ?? activity.summary ?? activity.type ?? "activity",
  )
    .replace(/\s+/g, " ")
    .trim();
}


const execFileAsync = promisify(execFile);

export async function prepareWorktree({
  repoCwd,
  repo,
  cwd,
  worktree,
  message,
}: AnyRecord) {
  const repoRoot = await repositoryRoot(repoCwd, repo);
  const branchInput = stringOrUndefined(worktree);
  const fallbackName = worktreeSlug(
    branchInput ?? stringOrUndefined(cwd) ?? stringOrUndefined(message),
  );
  const worktreePath = path.resolve(
    repoRoot,
    cwd
      ? String(cwd)
      : path.join(".agentfiles", "worktrees", fallbackName),
  );
  const branch = gitBranchName(
    branchInput ?? path.basename(worktreePath) ?? fallbackName,
  );

  await ensureGitWorktree(repoRoot, worktreePath, branch);

  return worktreePath;
}

async function repositoryRoot(repoCwd: unknown, repo: unknown) {
  const base = String(repoCwd || process.cwd());
  const source = stringOrUndefined(repo);
  const repositoryPath = source ? path.resolve(base, source) : base;

  try {
    return await gitOutput(repositoryPath, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    throw new Error(
      `Worktree repository must be a git repository: ${repositoryPath}`,
      { cause: error },
    );
  }
}

async function ensureGitWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
) {
  if (existsSync(path.join(worktreePath, ".git"))) return;

  try {
    await gitOutput(repoRoot, ["worktree", "add", worktreePath, branch]);
  } catch {
    await gitOutput(repoRoot, [
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      "HEAD",
    ]);
  }
}

async function gitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 30_000,
    windowsHide: true,
  });

  return stdout.trim();
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function worktreeSlug(value: unknown) {
  const source = String(value ?? "agent-worktree");
  const base = source
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return `${base || "agent-worktree"}-${hashText(source)}`;
}

function gitBranchName(value: unknown) {
  return (
    String(value ?? "agent-worktree")
      .replace(/\\/g, "/")
      .split("/")
      .map((part) =>
        part
          .replace(/[^A-Za-z0-9._-]+/g, "-")
          .replace(/^[-.]+|[-.]+$/g, ""),
      )
      .filter(Boolean)
      .join("/") || "agent-worktree"
  );
}

function hashText(value: string) {
  let hash = 5381;

  for (const char of value) hash = ((hash << 5) + hash) ^ char.charCodeAt(0);

  return Math.abs(hash >>> 0).toString(36).slice(0, 6);
}


type CallerMessageDelivery = {
  callerSessionId?: string;
  callerSessionManager: PiSessionManager;
  callerCwd?: string;
  config: AnyRecord;
  text: string;
  invoke: boolean;
  queue?: string;
};

export class PiGenticOrchestrator {
  pi: PiApi;
  currentAgentName?: string;

  constructor(pi: PiApi) {
    this.pi = pi;
    this.currentAgentName = undefined;
  }

  load(ctx) {
    return loadConfiguration({ cwd: ctx.cwd });
  }

  getActiveAgent(ctx, config = this.load(ctx)) {
    const state = getActiveState(ctx.sessionManager);

    return config.agents.find((agent) => agent.name === state.agentName);
  }

  resolvePolicy(
    ctx: PiContext,
    config: AnyRecord = this.load(ctx),
    state = getActiveState(ctx.sessionManager),
    resources: AnyRecord = {},
  ) {
    const activeAgent = config.agents.find(
      (agent) => agent.name === state.agentName,
    );

    return resolveSessionPolicy({
      settings: config.settings,
      activeAgent,
      overrides: state.overrides,
      allAgents: config.agents.map((agent) => agent.name),
      allTools:
        resources.tools ?? this.pi.getAllTools().map((tool) => tool.name),
      allSkills: resources.skills ?? currentSkillNames(ctx),
    });
  }

  availableAgents(ctx: PiContext, config: AnyRecord = this.load(ctx)) {
    return filterAvailableAgents(config, this.resolvePolicy(ctx, config));
  }

  assertAgentAvailable(
    ctx: PiContext,
    agentName: unknown,
    config: AnyRecord = this.load(ctx),
  ) {
    const configured = config.agents.find(
      (agent) =>
        agent.name.toLowerCase() === String(agentName ?? "").toLowerCase(),
    );

    if (!configured)
      throw new Error(
        `Unknown agent "${agentName}". Available agents: ${config.agents.map((agent) => agent.name).join(", ") || "none"}.`,
      );

    return assertAvailableAgent(agentName, this.availableAgents(ctx, config));
  }

  async applyCurrentPolicy(ctx: PiContext, options: AnyRecord = {}) {
    const config = this.load(ctx);
    const state = getActiveState(ctx.sessionManager);
    const policy = this.resolvePolicy(ctx, config, state, {
      skills: skillContext(ctx).names,
    });
    this.currentAgentName = policy.agentName;
    this.pi.setActiveTools(policy.resources.tools);

    if (policy.model) {
      const model = this.resolveModel(ctx, policy.model);

      if (model) await this.pi.setModel(model);
    }

    if (policy.thinking) this.pi.setThinkingLevel(policy.thinking);

    if (policy.theme && ctx.mode === "tui") ctx.ui.setTheme(policy.theme);
    this.setTitle(ctx, options.running === true);
    this.setAgentWidget(ctx);

    return { config, policy };
  }

  setTitle(ctx, running = false) {
    const agent = activeAgentName(ctx.sessionManager);

    if (agent) ctx.ui.setTitle(`${running ? "●" : "○"} ${agent}`);
  }

  setAgentWidget(ctx) {
    setAgentLabel(ctx, activeAgentName(ctx.sessionManager));
  }

  buildPromptAppend(ctx, event) {
    const skills = skillContext(ctx, parseSkillEntries(event.systemPrompt));
    const { config, policy, activeAgent } = this.applyPolicySnapshot(ctx, {
      skills: skills.names,
    });

    return {
      systemPrompt: buildResolvedSystemPrompt({
        baseSystemPrompt: event.systemPrompt,
        config: { ...config, activeAgent },
        policy,
        skillEntries: skills.entries,
      }),
    };
  }

  applyPolicySnapshot(ctx: PiContext, resources: AnyRecord = {}) {
    const config = this.load(ctx);
    const state = getActiveState(ctx.sessionManager);
    const activeAgent = config.agents.find(
      (agent) => agent.name === state.agentName,
    );
    const policy = this.resolvePolicy(ctx, config, state, {
      ...resources,
      skills: resources.skills ?? skillContext(ctx).names,
    });
    this.currentAgentName = policy.agentName;

    return { config, policy, activeAgent };
  }

  async loadDefaultAgent(ctx, event) {
    const config = this.load(ctx);
    const agentName = configuredDefaultAgent(config.settings);

    if (!agentName || !shouldApplyDefaultAgent(event, ctx.sessionManager))
      return undefined;

    if (
      !config.agents.some(
        (agent) => agent.name.toLowerCase() === agentName.toLowerCase(),
      )
    ) {
      ctx.ui.notify(
        `pi-gentic defaultAgent "${agentName}" is not configured.`,
        "warning",
      );
      await this.applyCurrentPolicy(ctx);

      return undefined;
    }

    return this.loadAgent(ctx, agentName, { enforceAccess: false });
  }

  async cycleAgent(ctx) {
    const config = this.load(ctx);
    const agentName = nextAgentName(
      activeAgentName(ctx.sessionManager),
      config.agents,
    );

    return this.loadAgent(ctx, agentName ?? "clear");
  }

  async loadAgent(ctx: PiContext, agentName: unknown, options: AnyRecord = {}) {
    const config = this.load(ctx);

    if (!agentName || agentName === "clear") {
      appendActiveState(ctx.sessionManager, {
        agentName: undefined,
        overrides: undefined,
      });
      const { policy } = await this.applyCurrentPolicy(ctx);

      return {
        text: "Cleared active agent.",
        details: this.cardDetails("load", "done", {
          agentName: "agentless",
          sessionId: ctx.sessionManager.getSessionId(),
          configuration: compactPolicy(policy),
          systemPrompt: this.resolvedPromptForCard(
            ctx,
            config,
            policy,
            undefined,
          ),
        }),
      };
    }

    const agent =
      options.enforceAccess === false
        ? config.agents.find(
            (item) =>
              String(item.name).toLowerCase() ===
              String(agentName).toLowerCase(),
          )
        : this.assertAgentAvailable(ctx, agentName, config);

    if (!agent)
      throw new Error(
        `Unknown agent "${agentName}". Available agents: ${config.agents.map((item) => item.name).join(", ") || "none"}.`,
      );
    appendActiveState(ctx.sessionManager, {
      agentName: agent.name,
      overrides: options.overrides,
    });
    const { policy } = await this.applyCurrentPolicy(ctx);

    return {
      text: `Loaded ${agent.name} agent in session ${shortSessionId(ctx.sessionManager.getSessionId())}.`,
      details: this.cardDetails("load", "done", {
        agentName: agent.name,
        sessionId: ctx.sessionManager.getSessionId(),
        configuration: compactPolicy(policy),
        systemPrompt: this.resolvedPromptForCard(ctx, config, policy, agent),
      }),
    };
  }

  resolvedPromptForCard(ctx, config, policy, activeAgent) {
    const baseSystemPrompt = safeSystemPrompt(ctx);

    return buildResolvedSystemPrompt({
      baseSystemPrompt,
      config: { ...config, activeAgent },
      policy,
      skillEntries: skillContext(ctx, parseSkillEntries(baseSystemPrompt))
        .entries,
    });
  }

  async send(ctx: PiContext, input: AnyRecord, callbacks: AnyRecord = {}) {
    const config = this.load(ctx);

    if (input.agent) this.assertAgentAvailable(ctx, input.agent, config);
    const callerState = getActiveState(ctx.sessionManager);
    const callerAgent = callerState.agentName;
    const defaults =
      this.resolvePolicy(ctx, config, callerState).agentsTool ?? {};
    const targetAsync = input.sessionId
      ? true
      : chooseBoolean(input.async, chooseBoolean(defaults.async, false));
    const targetFork = chooseBoolean(
      input.fork,
      chooseBoolean(defaults.fork, false),
    );
    const cwd = await this.resolveSendCwd(ctx, {
      ...input,
      cwd: input.cwd ?? defaults.cwd,
    });
    const invokeMeLater = chooseBoolean(
      input.invokeMeLater,
      targetAsync
        ? defaults.invokeMeLater?.async !== false
        : defaults.invokeMeLater?.withSession !== false,
    );
    const startedAt = Date.now();
    const returnDelivery = resolveReturnDelivery({
      async: targetAsync,
      awaitCompletion: callbacks.awaitCompletion,
    });
    const target = await this.resolveTargetSession(
      ctx,
      { ...input, async: targetAsync, fork: targetFork, cwd },
      config,
    );
    const targetSessionId = target.session.sessionManager.getSessionId();
    const targetBusy = target.session.isStreaming === true;
    const callerSessionManager = ctx.sessionManager;
    const callerSessionId = callerSessionManager.getSessionId();
    const callerCwd = ctx.cwd;
    const details = this.cardDetails(
      "send",
      targetBusy ? "queued" : "running",
      {
        cardId: `send:${targetSessionId}:${startedAt}`,
        async: targetAsync,
        agentName: target.agentName,
        sessionId: targetSessionId,
        message: input.message,
        queued: targetBusy,
        startedAt,
        updatedAt: startedAt,
        activities: [],
      },
    );
    const publish = (nextDetails: AnyRecord, options: AnyRecord = {}) => {
      const liveDetails = setLiveCardDetails(nextDetails) ?? nextDetails;

      if (options.refresh !== false) callbacks.onRefresh?.(liveDetails);

      if (options.notify === true)
        callbacks.onUpdate?.({
          content: [{ type: "text", text: sendStatusText(liveDetails) }],
          details: liveDetails,
        });

      return liveDetails;
    };
    publish(details, { notify: true });
    deliverSendContextToCaller({
      pi: this.pi,
      ctx,
      target,
      message: input.message,
      async: targetAsync,
      fork: targetFork,
    });
    const activeCall = registerAgentCall({
      callerSessionId,
      targetSessionId,
      abort: async (options: AnyRecord = {}) => {
        target.lastAbort = {
          actor: options.actor ?? abortActor(ctx),
          at: Date.now(),
        };
        await target.session.abort();
      },
    });
    const abortFromSignal = () =>
      void abortAgentCall(activeCall.id, { actor: abortActor(ctx) });
    callbacks.signal?.addEventListener?.("abort", abortFromSignal, {
      once: true,
    });
    const run = async () => {
      target.runStartedAt ??= startedAt;
      const monitor = createSessionActivityMonitor(details, (nextDetails) => {
        target.lastActivityAt = new Date(
          nextDetails.updatedAt ?? Date.now(),
        ).toISOString();
        target.lastActivities =
          nextDetails.activities ?? target.lastActivities ?? [];

        return publish(nextDetails);
      });
      const unsubscribe =
        typeof target.session.subscribe === "function"
          ? target.session.subscribe((event) => monitor.observe(event))
          : undefined;

      try {
        const receipt = buildReceiptText(
          callerAgent,
          callerSessionId,
          input.message,
        );
        await target.session.prompt(
          receipt,
          target.session.isStreaming
            ? { streamingBehavior: "steer" }
            : undefined,
        );
        if (targetBusy) await waitForSessionTurnEnd(target.session, callbacks.signal);
        const outcome = sessionRunOutcome(target, { request: input.message });
        const completed =
          outcome.status === "done"
            ? monitor.finish({
                activities: mergeActivities(
                  monitor.activities,
                  collectSessionActivities(target.session),
                ),
              })
            : monitor.stop(outcome.status, {
                error: outcome.text,
                activities: mergeActivities(
                  monitor.activities,
                  collectSessionActivities(target.session),
                ),
              });
        target.lastActivities =
          completed.activities ?? target.lastActivities ?? [];
        target.runStartedAt = undefined;
        if (outcome.status === "done")
          await displayTargetAnswerIfVisible({
            ctx: activeVisibleContext() ?? ctx,
            target: getRuntimeSession(targetSessionId) ?? target,
            targetSessionId,
            text: outcome.text,
          });
        const returnText =
          outcome.status === "done"
            ? buildReturnText(target.agentName, targetSessionId, outcome.text)
            : outcome.text;
        if (returnDelivery.kind === "callerMessage") {
          await this.deliverCallerMessage(ctx, {
            callerSessionId,
            callerSessionManager,
            callerCwd,
            config,
            text: returnText,
            invoke: invokeMeLater,
            queue: returnDelivery.queue,
          });

          return { answer: outcome.text, details: completed };
        }

        return { answer: returnText, details: completed };
      } catch (error) {
        const outcome = sessionRunOutcome(target, {
          request: input.message,
          error,
        });
        const failed = monitor.stop(outcome.status, {
          error: outcome.text,
          activities: mergeActivities(
            monitor.activities,
            collectSessionActivities(target.session),
          ),
        });
        target.lastActivities =
          failed.activities ?? target.lastActivities ?? [];
        target.runStartedAt = undefined;
        if (returnDelivery.kind === "callerMessage")
          await this.deliverCallerMessage(ctx, {
            callerSessionId,
            callerSessionManager,
            callerCwd,
            config,
            text: outcome.text,
            invoke: invokeMeLater,
            queue: returnDelivery.queue,
          });

        return { answer: outcome.text, details: failed };
      } finally {
        unsubscribe?.();
        setRuntimeSession(targetSessionId, target);
        callbacks.signal?.removeEventListener?.("abort", abortFromSignal);
        activeCall.unregister();

        if (target.session.isStreaming !== true)
          unregisterLiveRuntime(targetSessionId);
        pruneRuntimeSessions();
      }
    };

    if (returnDelivery.kind === "callerMessage") {
      void run()
        .catch((error) =>
          this.pi.sendMessage(
            {
              customType: "pi-gentic:card",
              content: getErrorMessage(error),
              display: true,
              details: this.cardDetails("send", "error", {
                ...details,
                error: getErrorMessage(error),
                completedAt: Date.now(),
              }),
            },
            { triggerTurn: false, deliverAs: "nextTurn" },
          ),
        )
        .finally(() => callbacks.onSettled?.());

      return {
        text: sendPendingText({
          async: targetAsync,
          agentName: target.agentName,
          sessionId: target.session.sessionManager.getSessionId(),
          message: input.message,
          details,
        }),
        details: this.cardDetails("send", details.status ?? "running", details),
      };
    }

    const result = await run();
    callbacks.onSettled?.();

    return { text: result.answer, details: result.details };
  }

  async resolveSendCwd(ctx: PiContext, input: AnyRecord) {
    if (input.worktree === undefined) return input.cwd ?? ctx.cwd;

    return this.prepareWorktree(ctx, input);
  }

  async prepareWorktree(ctx: PiContext, input: AnyRecord) {
    return prepareWorktree({ ...input, repoCwd: ctx.cwd });
  }

  async resolveTargetSession(
    ctx: PiContext,
    input: AnyRecord,
    config: AnyRecord,
  ): Promise<PiRuntimeSession> {
    if (input.sessionId) {
      const session = await this.getOrOpenSession(
        ctx,
        input.sessionId,
        input.cwd,
      );

      assertDifferentSession(
        ctx.sessionManager.getSessionId(),
        session.session.sessionManager.getSessionId(),
      );

      if (input.agent)
        await this.loadAgentIntoSession(
          session.session,
          input.agent,
          input.overrides,
          config,
        );
      else if (input.overrides)
        await this.applySessionOverrides(session.session, input.overrides, config);

      return session;
    }

    const session = await this.createChildSession(ctx, input, config);

    if (input.agent)
      await this.loadAgentIntoSession(
        session.session,
        input.agent,
        input.overrides,
        config,
      );
    else if (input.overrides)
      await this.applySessionOverrides(session.session, input.overrides, config);
    else
      await this.applyAgentlessPolicyToNewSession(
        session.session,
        config,
        ctx.model,
      );

    if (typeof input.agent === "string") session.agentName = input.agent;

    return session;
  }

  async assertCanCreateChildSession(ctx: PiContext, config: AnyRecord) {
    const policy = this.resolvePolicy(ctx, config);
    const currentDepth = await this.currentSessionDepth(ctx);

    return assertCanCreateSubagent({
      currentDepth,
      maxSubagentDepth: policy.maxSubagentDepth,
      globalMaxSubagentDepth: config.settings.globalMaxSubagentDepth,
    });
  }

  async currentSessionDepth(ctx: PiContext) {
    const current = currentSessionSummary(ctx);

    if (!current) return 0;
    const sessionDir = ctx.sessionManager.getSessionDir();
    const persisted = await listDiscoverySessionSources(ctx.cwd, sessionDir);
    return resolveCurrentSessionDepth(current, persisted, listRuntimeSessions());
  }

  async createChildSession(
    ctx: PiContext,
    input: AnyRecord,
    config: AnyRecord = this.load(ctx),
  ): Promise<PiRuntimeSession> {
    let sessionManager;
    const sessionDir = ctx.sessionManager.getSessionDir();
    persistSessionImmediately(ctx.sessionManager);
    await this.assertCanCreateChildSession(ctx, config);
    const parentSession = ctx.sessionManager.getSessionFile();

    if (input.fork && parentSession) {
      sessionManager = (SessionManager as any).forkFrom(
        parentSession,
        input.cwd ?? ctx.cwd,
        sessionDir,
      );
    } else {
      sessionManager = (SessionManager as any).create(input.cwd ?? ctx.cwd, sessionDir);
      if (parentSession) {
        const header = sessionManager.getHeader?.();
        if (header) header.parentSession = parentSession;
      }
    }

    if (typeof sessionManager.appendSessionInfo === "function")
      sessionManager.appendSessionInfo(input.message);
    persistSessionImmediately(sessionManager);
    const runtimeHost = await createLiveRuntime({
      cwd: input.cwd ?? ctx.cwd,
      sessionManager,
    });
    const runtime: PiRuntimeSession = {
      runtimeHost,
      session: runtimeHost.session,
      agentName: undefined,
      parentSessionPath: parentSession,
      lastMessage: input.message,
      createdAt: new Date().toISOString(),
    };
    setRuntimeSession(
      runtimeHost.session.sessionManager.getSessionId(),
      runtime,
    );

    return runtime;
  }

  async getOrOpenSession(
    ctx: PiContext,
    reference: unknown,
    cwd?: string,
  ): Promise<PiRuntimeSession> {
    const runtimeMatches = listRuntimeSessions().filter((runtime) =>
      matchesSession(runtime.session.sessionManager.getSessionId(), reference),
    );
    const runtimeIds = new Set(
      runtimeMatches.map((runtime) => runtime.session.sessionManager.getSessionId()),
    );

    if (runtimeIds.size === 1) return runtimeMatches[0];

    if (runtimeIds.size > 1)
      throw new Error(
        `Ambiguous session reference "${reference}" matches ${runtimeIds.size} sessions.`,
      );
    const sessions = await (SessionManager as any).list(
      cwd ?? ctx.cwd,
      ctx.sessionManager.getSessionDir(),
    );
    const resolved = resolveSessionReference(sessions, reference);
    const sessionManager = (SessionManager as any).open(
      resolved.path,
      ctx.sessionManager.getSessionDir(),
      cwd,
    );
    const runtimeHost = await createLiveRuntime({
      cwd: cwd ?? sessionManager.getCwd(),
      sessionManager,
    });
    const state = getActiveState(sessionManager);
    const runtime: PiRuntimeSession = {
      runtimeHost,
      session: runtimeHost.session,
      agentName: state.agentName,
      parentSessionPath: sessionManager.getHeader?.()?.parentSession,
    };
    setRuntimeSession(
      runtimeHost.session.sessionManager.getSessionId(),
      runtime,
    );

    return runtime;
  }

  async loadAgentIntoSession(
    session: PiAgentSession,
    agentName: string,
    overrides: unknown,
    config: AnyRecord,
    accessContext?: PiContext,
  ) {
    const agent = accessContext
      ? this.assertAgentAvailable(accessContext, agentName, config)
      : config.agents.find(
          (item) => item.name.toLowerCase() === agentName.toLowerCase(),
        );

    if (!agent) throw new Error(`Unknown agent "${agentName}".`);
    appendActiveState(session.sessionManager, {
      agentName: agent.name,
      overrides,
    });
    await this.applyPolicyToAgentSession(session, config);
    setRuntimeSession(session.sessionManager.getSessionId(), {
      session,
      agentName: agent.name,
    });
  }

  async applySessionOverrides(session, overrides, config) {
    const state = getActiveState(session.sessionManager);

    appendActiveState(session.sessionManager, {
      agentName: state.agentName,
      overrides,
    });

    return this.applyPolicyToAgentSession(session, config);
  }

  async applyPolicyToAgentSession(session, config) {
    const policy = this.resolveAgentSessionPolicy(session, config);
    session.setActiveToolsByName(policy.resources.tools);

    if (policy.model) {
      const model = resolveModelFromRegistry(
        session.modelRegistry,
        policy.model,
      );

      if (model) await session.setModel(model);
    }

    if (policy.thinking) session.setThinkingLevel(policy.thinking);

    return policy;
  }

  async applyAgentlessPolicyToNewSession(session, config, inheritedModel) {
    const policy = await this.applyPolicyToAgentSession(session, config);
    await applyInheritedModel(session, policy, inheritedModel);

    return policy;
  }

  resolveAgentSessionPolicy(session, config) {
    const state = getActiveState(session.sessionManager);
    const activeAgent = config.agents.find(
      (agent) => agent.name === state.agentName,
    );

    return resolveSessionPolicy({
      settings: config.settings,
      activeAgent,
      overrides: state.overrides,
      allAgents: config.agents.map((agent) => agent.name),
      allTools: session.getAllTools().map((tool) => tool.name),
      allSkills: session.resourceLoader
        .getSkills()
        .skills.map((skill) => skill.name),
    });
  }

  async status(ctx, sessionId) {
    if (!sessionId)
      throw new Error('Field "sessionId" is required for status.');
    const runtime = await this.getOrOpenSession(ctx, sessionId);

    return sessionStatus(runtime);
  }

  async abort(ctx, sessionId) {
    if (!sessionId) {
      ctx.abort();

      return `Aborted session ${shortSessionId(ctx.sessionManager.getSessionId())}.`;
    }

    const runtime = await this.getOrOpenSession(ctx, sessionId);
    runtime.lastAbort = { actor: abortActor(ctx), at: Date.now() };
    await runtime.session.abort();

    return `Aborted session ${shortSessionId(runtime.session.sessionManager.getSessionId())}.`;
  }

  async deliverCallerMessage(
    ctx: PiContext,
    {
      callerSessionId,
      callerSessionManager,
      callerCwd,
      config,
      text,
      invoke,
      queue,
    }: CallerMessageDelivery,
  ) {
    return deliverReturnToCaller({
      pi: this.pi,
      ctx: activeVisibleContext() ?? ctx,
      callerSessionId,
      callerSessionManager,
      text,
      invoke,
      persist: persistSessionImmediately,
      visibleSession: activeVisibleSession(),
      queue,
      invokeInactiveCaller: (text) =>
        this.invokeCallerSession({
          callerSessionManager,
          callerCwd,
          text,
          config,
          queue,
        }),
    });
  }

  async invokeCallerSession({
    callerSessionManager,
    callerCwd,
    text,
    config,
    queue = "steer",
  }) {
    const sessionId = callerSessionManager.getSessionId();
    const existing = findRuntimeSession(
      (runtime) => runtime.session.sessionManager.getSessionId() === sessionId,
    );
    const runtime =
      existing ??
      (await this.createRuntimeForSessionManager(
        callerSessionManager,
        callerCwd,
      ));
    await this.applyPolicyToAgentSession(runtime.session, config);
    runtime.lastMessage = text;
    runtime.lastActivityAt = new Date().toISOString();
    void runtime.session
      .prompt(
        text,
        runtime.session.isStreaming ? { streamingBehavior: queue } : undefined,
      )
      .catch((error) => {
        runtime.lastActivityAt = new Date().toISOString();
        runtime.session.sessionManager.appendCustomMessageEntry?.(
          "pi-gentic:return-invoke-error",
          getErrorMessage(error),
          true,
          { kind: "returnInvokeError" },
        );
        persistSessionImmediately(runtime.session.sessionManager);
      });
  }

  async createRuntimeForSessionManager(
    sessionManager: PiSessionManager,
    cwd?: string,
  ): Promise<PiRuntimeSession> {
    persistSessionImmediately(sessionManager);
    const runtimeHost = await createLiveRuntime({
      cwd: cwd ?? sessionManager.getCwd(),
      sessionManager,
    });
    const state = getActiveState(sessionManager);
    const runtime: PiRuntimeSession = {
      runtimeHost,
      session: runtimeHost.session,
      agentName: state.agentName,
      parentSessionPath: sessionManager.getHeader?.()?.parentSession,
      createdAt: new Date().toISOString(),
    };
    setRuntimeSession(
      runtimeHost.session.sessionManager.getSessionId(),
      runtime,
    );

    return runtime;
  }

  async discoverSessions(ctx, input) {
    const policy = this.resolvePolicy(ctx, this.load(ctx));
    const rx = parseIntegerRadius(input.rx, "rx", policy.agentsTool?.rx ?? 0);
    const ry = parseIntegerRadius(input.ry, "ry", policy.agentsTool?.ry ?? 0);
    const current = currentSessionSummary(ctx);
    const sessionDir = ctx.sessionManager.getSessionDir();
    const persisted = await cachedPersistedSessions(
      `${ctx.cwd ?? ""}\n${sessionDir ?? ""}`,
      () => listDiscoverySessionSources(ctx.cwd, sessionDir),
    );
    const tree = buildSessionTree(current, persisted, listRuntimeSessions());
    const related = sessionDiscoveryScope(tree, current, {
      rx,
      ry,
      all: input.all,
    });
    const enriched = enrichSessionSummaries(related, input.all ? 30 : 20);

    return {
      rx,
      ry,
      sessions: assignTreeDepths(enriched).map(withRuntimeState),
    };
  }

  resolveModel(ctx, modelName) {
    return resolveModelFromRegistry(ctx.modelRegistry, modelName);
  }

  cardDetails(kind, status, details = {}) {
    return { kind, status, updatedAt: Date.now(), ...details };
  }
}

async function listDiscoverySessionSources(cwd, sessionDir) {
  const fast = listSessionSummariesFast(sessionDir);

  return fast.length > 0 ? fast : (SessionManager as any).list(cwd, sessionDir);
}

function currentSkillNames(ctx) {
  try {
    return (
      ctx
        .getSystemPromptOptions?.()
        .skills?.map((skill) => skill.name)
        .filter(Boolean) ?? []
    );
  } catch {
    return [];
  }
}

function skillContext(ctx, parsedEntries = []) {
  const entries = mergeSkillEntries(
    loadAvailableSkills({ cwd: ctx.cwd }),
    parsedEntries,
  );
  const names = entries.map((skill) => skill.name);

  return { entries, names: names.length > 0 ? names : currentSkillNames(ctx) };
}

function safeSystemPrompt(ctx) {
  try {
    return ctx.getSystemPrompt?.() ?? "";
  } catch {
    return "";
  }
}

function compactPolicy(policy) {
  return {
    model: policy.model,
    thinking: policy.thinking,
    theme: policy.theme,
    tools: policy.resources.tools,
    agents: policy.resources.agents,
    skills: policy.resources.skills,
    systemPromptFiles: policy.systemPromptFiles,
    maxSubagentDepth: policy.maxSubagentDepth,
  };
}

function matchesSession(sessionId, reference) {
  const id = String(sessionId).toLowerCase();
  const query = String(reference).toLowerCase();

  return (
    id === query ||
    id.startsWith(query) ||
    id.includes(query) ||
    shortSessionId(id) === query
  );
}
