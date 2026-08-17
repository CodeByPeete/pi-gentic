import { inspect } from "node:util";
import { isSessionActivityEvent, runtimeSessionIsRunning } from "../../infrastructure/pi/host.js";
import type { PiAgentSession, PiRuntimeSession } from "../../infrastructure/pi/types.js";
import type { UnknownRecord } from "../../shared/types.js";
import { errorMessage as getErrorMessage, formatDuration, isRecord, shortSessionId } from "../../shared/value.js";
import type { SendCardDetails } from "./contracts.js";

const MAX_PERSISTED_ACTIVITIES = 100;
const ACTIVITY_PREVIEW_LENGTH = 240;
const ACTIVITY_INSPECT_OPTIONS = { depth: 2, maxArrayLength: 10, maxStringLength: ACTIVITY_PREVIEW_LENGTH } as const;
const TOOL_ACTIVITY_EVENTS: Record<string, { summary: string; status?: string }> = {
  tool_execution_start: { summary: "args", status: "running" },
  tool_execution_update: { summary: "partialResult", status: "running" },
  tool_execution_end: { summary: "result" },
};

export function createSessionActivityMonitor(
  baseDetails: UnknownRecord,
  publish: (details: UnknownRecord) => UnknownRecord,
) {
  const initialActivities = Array.isArray(baseDetails.activities)
    ? baseDetails.activities.filter(isRecord).slice(-MAX_PERSISTED_ACTIVITIES)
    : [];
  const state: SendCardDetails & {
    activities: UnknownRecord[];
    activityCount: number;
    updatedAt: number;
  } = {
    ...baseDetails,
    activities: initialActivities,
    activityCount: Math.max(Number(baseDetails.activityCount ?? 0), initialActivities.length),
    updatedAt: typeof baseDetails.updatedAt === "number" ? baseDetails.updatedAt : Date.now(),
  };
  const activityIndexes = new Map<unknown, number>();
  const seenActivities = new Set(initialActivities.map(activityKey));
  initialActivities.forEach((activity, index) => activityIndexes.set(activityKey(activity), index));
  const recordActivities = (activities: unknown[]) => {
    for (const activity of activities.filter(isRecord))
      if (upsertActivity(state.activities, activity, activityIndexes, seenActivities, MAX_PERSISTED_ACTIVITIES))
        state.activityCount += 1;
  };
  const projectAssistantDelta = createAssistantDeltaProjector();
  const publishState = (status = state.status, updates: UnknownRecord = {}) => {
    Object.assign(state, updates, { status });
    const { activityCount, ...details } = state;
    const activities = [...state.activities];

    return publish(
      activityCount > activities.length ? { ...details, activities, activityCount } : { ...details, activities },
    );
  };
  const touch = () => {
    state.updatedAt = Date.now();
  };

  return {
    get activities() {
      return state.activities;
    },
    observe(event: unknown) {
      if (!isRecord(event) || !isSessionActivityEvent(event)) return;
      const activity = eventToActivity(event, projectAssistantDelta);

      if (state.status === "queued") {
        const message = isRecord(event.message) ? event.message : undefined;
        if (event.type !== "message_start" || message?.role !== "user") return;
        touch();
        publishState("running");
        return;
      }

      touch();
      if (activity) recordActivities([activity]);
      publishState("running");
    },
    finish(updates: UnknownRecord = {}) {
      const { activities = [], ...details } = updates;

      recordActivities(Array.isArray(activities) ? activities : []);
      return publishState("done", {
        ...details,
        completedAt: Date.now(),
        updatedAt: state.updatedAt,
      });
    },
    stop(status: string, updates: UnknownRecord = {}) {
      recordActivities(Array.isArray(updates.activities) ? updates.activities : []);

      return publishState(status, {
        completedAt: Date.now(),
        updatedAt: state.updatedAt,
        ...updates,
      });
    },
    fail(error: unknown) {
      return publishState("error", {
        completedAt: Date.now(),
        error: getErrorMessage(error),
      });
    },
  };
}

export function recordRunResult(runtime: PiRuntimeSession, details: UnknownRecord) {
  runtime.lastActivities = Array.isArray(details.activities)
    ? details.activities.filter(isRecord)
    : (runtime.lastActivities ?? []);
  runtime.runStartedAt = undefined;

  return details;
}

export function completeSessionActivities(session: PiAgentSession) {
  const messages = session.agent.state.messages;

  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => {
    if (!isRecord(message)) return [];
    if (message.role === "assistant") return assistantMessageActivities(message);

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

function mergeActivities(...activityLists: unknown[][]) {
  const merged: UnknownRecord[] = [];
  const indexes = new Map<unknown, number>();

  for (const activity of activityLists.flat().filter(isRecord)) upsertActivity(merged, activity, indexes);

  return merged;
}

export function lastRuntimeActivities(runtime: PiRuntimeSession) {
  return mergeActivities(completeSessionActivities(runtime.session), runtime.lastActivities ?? []);
}

function latestActivityLines(runtime: PiRuntimeSession, count = 3) {
  return lastRuntimeActivities(runtime).slice(-count).map(formatActivityLine).filter(Boolean);
}

function formatActivityLine(activity: UnknownRecord | undefined) {
  if (!activity) return undefined;

  if (activity.type === "assistant") return `assistant ${truncateInline(activity.text, 160)}`;
  const status = activity.status ? ` (${activity.status})` : "";

  return `[${activity.name ?? activity.type}] ${truncateInline(activity.summary ?? activity.text ?? "", 160)}${status}`.trim();
}

function eventToActivity(
  event: UnknownRecord,
  projectAssistantDelta: (event: UnknownRecord) => UnknownRecord | undefined = () => undefined,
) {
  const assistantDeltaActivity = projectAssistantDelta(event);
  const tool = typeof event.type === "string" ? TOOL_ACTIVITY_EVENTS[event.type] : undefined;

  if (tool)
    return {
      id: event.toolCallId,
      type: "tool",
      name: event.toolName,
      summary: summarizeValue(event[tool.summary] ?? event.args),
      status: tool.status ?? (event.isError ? "error" : "done"),
    };

  const message = isRecord(event.message) ? event.message : undefined;

  if (event.type === "message_update" && message?.role === "assistant") return assistantActivity(message);

  if (event.type === "message_update") return assistantDeltaActivity;

  if (event.type === "message_end" && message?.role === "assistant") return assistantActivity(message);
  return undefined;
}

function createAssistantDeltaProjector() {
  const textBlocks = new Map<number, string>();

  return (event: UnknownRecord) => {
    if (event.type === "message_start") {
      textBlocks.clear();
      return undefined;
    }
    if (event.type === "message_end") {
      textBlocks.clear();
      return undefined;
    }
    if (event.type !== "message_update" || !isRecord(event.assistantMessageEvent)) return undefined;
    const delta = event.assistantMessageEvent;
    const contentIndex = delta.contentIndex;

    if (typeof contentIndex !== "number" || !Number.isInteger(contentIndex) || contentIndex < 0 || contentIndex >= 10)
      return undefined;
    const index = contentIndex;

    if (delta.type === "text_start") textBlocks.set(index, "");
    else if (delta.type === "text_delta" && typeof delta.delta === "string")
      textBlocks.set(index, `${textBlocks.get(index) ?? ""}${delta.delta}`.slice(0, ACTIVITY_PREVIEW_LENGTH * 4));
    else if (delta.type === "text_end" && typeof delta.content === "string")
      textBlocks.set(index, delta.content.slice(0, ACTIVITY_PREVIEW_LENGTH * 4));
    else return undefined;

    const text = truncateInline(
      [...textBlocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, content]) => content)
        .join("\n"),
      ACTIVITY_PREVIEW_LENGTH,
    );

    return text ? { id: "assistant", type: "assistant", text } : undefined;
  };
}

function assistantMessageActivities(message: UnknownRecord) {
  const activities: UnknownRecord[] = [];
  const text = activityMessageText(message);

  if (text)
    activities.push({
      id: "assistant",
      type: "assistant",
      text,
      ...(["error", "aborted"].includes(String(message.stopReason)) ? { status: message.stopReason } : {}),
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
      text: assistantErrorMessage(message) || "Unknown error",
      status: "error",
    });

  if (Array.isArray(message.content)) {
    activities.push(
      ...message.content
        .filter((part: UnknownRecord) => part.type === "toolCall")
        .map((part: UnknownRecord) => ({
          id: part.id,
          type: "tool",
          name: part.name,
          summary: summarizeValue(part.arguments ?? {}),
        })),
    );
  }

  return activities;
}

function assistantActivity(message: UnknownRecord) {
  const text = activityMessageText(message);

  return text ? { id: "assistant", type: "assistant", text } : undefined;
}

function upsertActivity(
  activities: UnknownRecord[],
  activity: UnknownRecord,
  indexes: Map<unknown, number>,
  seen?: Set<unknown>,
  limit = Number.POSITIVE_INFINITY,
) {
  const key = activityKey(activity);
  const index = indexes.get(key);

  if (index !== undefined) {
    activities[index] = { ...activities[index], ...activity };
    return false;
  }
  if (seen?.has(key)) return false;
  seen?.add(key);
  if (activities.length >= limit) {
    indexes.delete(activityKey(activities.shift()!));
    activities.forEach((value, activityIndex) => indexes.set(activityKey(value), activityIndex));
  }
  indexes.set(key, activities.length);
  activities.push(activity);
  return true;
}

function activityKey(activity: UnknownRecord) {
  return activity.id ?? `${activity.type}:${activity.name ?? ""}`;
}

function summarizeValue(value: unknown) {
  if (typeof value === "string") return truncateInline(value, ACTIVITY_PREVIEW_LENGTH);
  if (isRecord(value) && Array.isArray(value.content)) return summarizeValue(value.content);
  if (Array.isArray(value))
    return truncateInline(
      value
        .slice(0, 10)
        .map((item) =>
          truncateInline(
            isRecord(item) && (item.text !== undefined || item.data !== undefined)
              ? (item.text ?? item.data)
              : inspect(item, ACTIVITY_INSPECT_OPTIONS),
            ACTIVITY_PREVIEW_LENGTH,
          ),
        )
        .join(" "),
      ACTIVITY_PREVIEW_LENGTH,
    );
  if (isRecord(value) && typeof value.text === "string") return truncateInline(value.text, ACTIVITY_PREVIEW_LENGTH);
  return truncateInline(inspect(value, ACTIVITY_INSPECT_OPTIONS), ACTIVITY_PREVIEW_LENGTH);
}

function activityMessageText(message: UnknownRecord) {
  return truncateInline(
    messageTextParts(message)
      .slice(0, 10)
      .map((text) => text.slice(0, ACTIVITY_PREVIEW_LENGTH * 4))
      .join("\n"),
    ACTIVITY_PREVIEW_LENGTH,
  );
}

function truncateInline(text: unknown, length: number) {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > length ? `${normalized.slice(0, Math.max(0, length - 1))}…` : normalized;
}

function assistantErrorMessage(message: UnknownRecord) {
  if (Array.isArray(message.diagnostics))
    for (let index = message.diagnostics.length - 1; index >= 0; index--) {
      const diagnostic = message.diagnostics[index];
      if (!isRecord(diagnostic) || !isRecord(diagnostic.error)) continue;
      const error = diagnostic.error.message;

      if (typeof error === "string" && error.trim()) return error.trim();
    }

  return typeof message.errorMessage === "string" ? message.errorMessage : undefined;
}

export function sessionRunOutcome(runtime: PiRuntimeSession, { request, error }: UnknownRecord = {}) {
  const session = runtime.session;
  const assistant = lastAssistantMessage(session.agent.state.messages);
  const text = assistantText(assistant);

  if (text && assistant?.stopReason !== "aborted" && assistant?.stopReason !== "error") return { status: "done", text };

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
        error: assistantErrorMessage(assistant),
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
    text: sessionOutcomeText(runtime, "stopped", {
      request,
      reason: stoppedRunReason(assistant),
      recentError: recentAssistantError(session.agent.state.messages, assistant),
    }),
  };
}

function stoppedRunReason(assistant: UnknownRecord | undefined) {
  if (!assistant) return "No assistant response was recorded.";

  if (assistant.stopReason === "length")
    return "The model reached its output token limit before returning a final answer.";

  if (assistant.stopReason)
    return `The model stopped with reason "${assistant.stopReason}" before returning a final answer.`;

  return "The assistant turn ended without a final answer.";
}

function recentAssistantError(messages: unknown[], terminalAssistant: UnknownRecord | undefined) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (message === terminalAssistant) continue;
    if (!isRecord(message)) continue;
    if (["user", "custom"].includes(String(message.role))) break;
    if (message.role !== "assistant" || message.stopReason !== "error") continue;
    const error = assistantErrorMessage(message);

    if (error) return error;
  }

  return undefined;
}

function sessionOutcomeText(
  runtime: PiRuntimeSession,
  kind: string,
  { request, error, reason, recentError }: UnknownRecord = {},
) {
  const session = runtime.session;
  const sessionId = shortSessionId(session.sessionManager.getSessionId?.());
  const agent = runtime.agentName ? ` [${runtime.agentName}]` : "";
  const lastAbort = isRecord(runtime.lastAbort) ? runtime.lastAbort : undefined;
  const actor = lastAbort?.actor ?? (kind === "aborted" ? "user in that session" : undefined);
  const activityLines = latestActivityLines(runtime).map((line) => `- ${line}`);
  const details = [
    kind === "aborted" ? `Session ${sessionId}${agent} was aborted while handling your request.` : undefined,
    kind === "aborted" ? `Aborted by: ${actor}.` : undefined,
    kind === "error" ? `Session ${sessionId}${agent} failed while handling your request.` : undefined,
    kind === "error" ? `Error: ${error || "Unknown error"}` : undefined,
    kind === "stopped" ? `Session ${sessionId}${agent} stopped before returning a final answer.` : undefined,
    kind === "stopped" && reason ? `Reason: ${reason}` : undefined,
    kind === "stopped" && recentError ? `Recent model error: ${recentError}` : undefined,
    request ? `Request: ${request}` : undefined,
    activityLines.length ? `Last activity:\n${activityLines.join("\n")}` : undefined,
  ].filter(Boolean);

  return details.join("\n");
}

function lastAssistantMessage(messages: unknown[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (isRecord(message) && message.role === "assistant") return message;
  }

  return undefined;
}

function assistantText(message: UnknownRecord | undefined) {
  return messageTextParts(message).join("\n").trim();
}

function messageTextParts(message: UnknownRecord | undefined) {
  if (typeof message?.content === "string") return [message.content];
  return Array.isArray(message?.content)
    ? message.content.flatMap((part) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
      )
    : [];
}

export function sessionStatus(runtime: PiRuntimeSession) {
  const now = Date.now();
  const running = runtimeSessionIsRunning(runtime);
  runtime.streamingStartedAt = running
    ? (runtime.runStartedAt ??
      runtime.streamingStartedAt ??
      runtime.lastActivityAt ??
      runtime.createdAt ??
      new Date(now).toISOString())
    : undefined;
  const lastActivityAt = runtime.lastActivityAt ?? runtime.createdAt;
  const inactiveMs = elapsedMs(now, lastActivityAt);
  const runningMs = running ? elapsedMs(now, runtime.runStartedAt ?? runtime.streamingStartedAt) : undefined;
  const pendingMessages = Number(runtime.session.pendingMessageCount ?? 0);
  const status = {
    sessionId: runtime.session.sessionManager.getSessionId(),
    agentName: runtime.agentName,
    running,
    state: running ? "running" : pendingMessages > 0 ? "queued" : "idle",
    pendingMessages,
    pendingText: pendingMessages === 1 ? "1 queued message" : `${pendingMessages} queued messages`,
    inactiveMs,
    inactiveText: formatDuration(inactiveMs),
    runningMs: runningMs ?? null,
    runningText: runningMs === undefined ? null : formatDuration(runningMs),
    lastActivities: lastRuntimeActivities(runtime).slice(-3),
  };

  return { ...status, text: formatSessionStatus(status) };
}

export function formatSessionStatus(status: UnknownRecord) {
  const title = `Session ${shortSessionId(status.sessionId)}${status.agentName ? ` [${status.agentName}]` : ""}`;
  const lines: Array<string | undefined> = [
    title,
    `State: ${status.state ?? (status.running ? "running" : "idle")}`,
    status.runningText ? `Running for: ${status.runningText}` : undefined,
    `Last activity: ${status.inactiveText ?? formatDuration(Number(status.inactiveMs ?? 0))} ago`,
    Number(status.pendingMessages ?? 0) > 0 ? `Queued messages: ${status.pendingMessages}` : undefined,
  ];
  const activities = Array.isArray(status.lastActivities) ? status.lastActivities : [];

  if (activities.length > 0) {
    lines.push("Recent activity:");
    lines.push(...activities.map((activity: UnknownRecord) => `- ${formatStatusActivity(activity)}`));
  }

  return lines.filter(Boolean).join("\n");
}

function elapsedMs(now: number, value: unknown) {
  const time =
    typeof value === "number"
      ? value
      : typeof value === "string" || value instanceof Date
        ? new Date(value).getTime()
        : undefined;

  return typeof time === "number" && Number.isFinite(time) ? Math.max(0, now - time) : 0;
}

function formatStatusActivity(activity: unknown) {
  if (!isRecord(activity)) return String(activity ?? "");

  if (activity.type === "tool") return `[${activity.name ?? "tool"}] ${activity.status ?? ""}`.trim();
  return String(activity.text ?? activity.summary ?? activity.type ?? "activity")
    .replace(/\s+/g, " ")
    .trim();
}
