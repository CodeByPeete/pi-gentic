/**
 * Run lifecycle helpers.
 *
 * A send action can start work, queue work, stream activity updates, return a
 * final answer, or report why the target session stopped.
 */
import { formatDuration, getErrorMessage, shortSessionId } from "./core.js";
import { getActiveState } from "./policy.js";

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
    // Context delivery is best-effort because command contexts can become stale after session switches.
  }
}

/** Delivers the target answer to the live caller, or persists it for later. */
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
}) {
  const liveDelivery = await deliverToLiveCaller({
    pi,
    ctx,
    callerSessionId,
    text,
    invoke,
    visibleSession,
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
}) {
  if (!contextStillActive(ctx, callerSessionId)) return { delivered: false };

  try {
    if (visibleSession) {
      if (invoke && typeof visibleSession.sendUserMessage === "function") {
        await visibleSession.sendUserMessage(text, sendUserMessageOptions(ctx));

        return { delivered: true, mode: "live" };
      }

      if (!invoke && typeof visibleSession.sendCustomMessage === "function") {
        await visibleSession.sendCustomMessage(
          returnContextMessage(text),
          { triggerTurn: false },
        );

        return { delivered: true, mode: "live" };
      }
    }

    if (invoke) pi.sendUserMessage(text, sendUserMessageOptions(ctx));
    else pi.sendMessage(returnContextMessage(text), { triggerTurn: false });

    return { delivered: true, mode: "live" };
  } catch {
    return { delivered: false };
  }
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

export function sendUserMessageOptions(ctx) {
  return ctx.isIdle?.() === false ? { deliverAs: "followUp" } : undefined;
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

/** Tracks assistant and tool activity so cards can update while a run is live. */
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

/** Converts the target session transcript into the result returned to the caller. */
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

/** Summarizes one runtime for status cards and tool responses. */
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
