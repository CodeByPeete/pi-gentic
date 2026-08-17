import { SessionManager, type AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { inspect } from "node:util";
import { Duration, Effect, Exit, Schema } from "effect";
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
  isRecord,
  loadAvailableSkills,
  loadConfiguration,
  mergeSkillEntries,
  parseIntegerRadius,
  parseSkillEntries,
  resolveSessionPolicy,
  shortSessionId,
  shouldApplyDefaultAgent,
  systemPromptSkillEntries,
  nextAgentName,
  type AgentDefinition,
} from "./catalog.js";
import { reportRuntimeDiagnostic } from "./diagnostics.js";
import {
  DelegationAborted,
  DelegationCompleted,
  DelegationFailed,
  DelegationStopped,
  type DelegationState,
} from "./domain/delegation.js";
import {
  AgentName,
  DelegationId,
  SessionId,
  type DelegationId as DelegationIdValue,
  type SessionId as SessionIdValue,
} from "./domain/identifiers.js";
import { reconcileActiveToolSelection, type ToolPolicyState } from "./domain/capabilities.js";
import { DelegationFibers } from "./infrastructure/runtime/DelegationFibers.js";
import { RuntimeMetadata, RuntimeRegistry } from "./infrastructure/runtime/RuntimeRegistry.js";
import {
  abortAgentCall,
  assertNoAgentCallCycle,
  activeVisibleContext,
  activeVisibleExtension,
  activeVisibleSession,
  applyInheritedModel,
  createLiveRuntime,
  findRuntimeSession,
  getRuntimeSession,
  isSessionActivityEvent,
  listRuntimeSessions,
  persistSessionImmediately,
  pruneRuntimeSessions,
  registerAgentCall,
  resolveModelFromCatalog,
  setRuntimeSession,
  unregisterLiveRuntime,
} from "./pi-host.js";
import {
  assertDifferentSession,
  assertSessionMessagingScope,
  assignTreeDepths,
  buildSessionTree,
  currentSessionSummary,
  enrichSessionSummaries,
  resolveCurrentSessionDepth,
  resolveSessionReference,
  runtimeSessionSummary,
  sessionDiscoveryScope,
  withRuntimeState,
} from "./sessions.js";
import { prepareWorktreeEffect, type ExtensionRuntime } from "./runtime/ExtensionRuntime.js";
import { AgentCallFailed } from "./domain/errors.js";
import type {
  PiAgentRuntimeHost,
  PiAgentSession,
  PiApi,
  PiContext,
  PiRuntimeSession,
  PiSessionManager,
  UnknownRecord,
} from "./pi-types.js";
import { prepareWorktree } from "./worktrees.js";
import {
  CARD_MESSAGE_TYPE,
  CARD_STATE_ENTRY_TYPE,
  PersistedCardDetailsSchema,
  isTerminalCard,
  prepareCardDetailsForHistory,
  setAgentLabel,
  setLiveCardDetails,
  setPersistedCardDetails,
} from "./ui.js";

type Configuration = ReturnType<typeof loadConfiguration>;
type SessionPolicy = ReturnType<typeof resolveSessionPolicy>;

interface SendCompletionOptions {
  async?: boolean;
  awaitCompletion?: boolean;
}

interface SendCardDetails extends UnknownRecord {
  status?: string;
  agentName?: string;
  error?: string;
}

interface SendInput extends UnknownRecord {
  message: string;
  agent?: string;
  sessionId?: string;
  async?: boolean;
  fork?: boolean;
  cwd?: string;
  worktree?: string | true;
  repo?: string;
  invokeMeLater?: boolean;
  overrides?: UnknownRecord;
}

interface SendCallbacks extends UnknownRecord {
  awaitCompletion?: boolean;
  onRefresh?: (details: UnknownRecord) => void;
  onUpdate?: AgentToolUpdateCallback<unknown>;
  signal?: AbortSignal;
  call?: UnknownRecord;
  onSettled?: () => void;
}

type DeliveryQueue = "followUp" | "steer";

type SessionController = Pick<
  PiAgentSession,
  "isStreaming" | "sessionManager" | "subscribe" | "sendCustomMessage" | "sendUserMessage"
> & {
  createReplacedSessionContext?: () => PiContext;
};

interface ReturnDeliveryParameters {
  pi: PiApi;
  ctx: PiContext;
  callerSessionId?: string;
  callerSessionManager: PiSessionManager;
  text: string;
  invoke: boolean;
  persist?: (sessionManager: PiSessionManager) => unknown;
  invokeInactiveCaller?: (message: unknown) => Promise<unknown>;
  visibleSession?: SessionController;
  queue?: DeliveryQueue;
}

interface CardDeliveryParameters extends ReturnDeliveryParameters {
  details: UnknownRecord;
}

interface CallerCardParameters {
  callerSessionId?: string;
  callerSessionManager: PiSessionManager;
  callerCwd: string;
  config: Configuration;
  text: string;
  details: UnknownRecord;
  invoke: boolean;
  queue?: DeliveryQueue;
}

interface CallerInvocationParameters {
  callerSessionManager: PiSessionManager;
  callerCwd: string;
  message: unknown;
  config: Configuration;
  queue?: DeliveryQueue;
}

export function abortActor(ctx: PiContext) {
  try {
    const agentName = getActiveState(ctx.sessionManager).agentName;

    return agentName ? `[${agentName}] agent` : "caller session";
  } catch (error) {
    reportRuntimeDiagnostic("abort-actor", error);
    return "caller session";
  }
}

export function shouldDeferSendCompletion({ async, awaitCompletion }: SendCompletionOptions = {}) {
  return async === true || awaitCompletion === false;
}

export function resolveReturnDelivery(
  options: SendCompletionOptions = {},
): { kind: "callerMessage"; queue: DeliveryQueue } | { kind: "toolResult"; queue?: undefined } {
  return shouldDeferSendCompletion(options) ? { kind: "callerMessage", queue: "steer" } : { kind: "toolResult" };
}

export function sendPendingText({
  async,
  agentName,
  sessionId,
  message,
  details,
}: {
  async?: boolean;
  agentName?: string;
  sessionId?: string;
  message: string;
  details?: SendCardDetails;
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
  options: { queued?: boolean } = {},
) {
  const target = agentName ? `[${agentName}] agent` : "agent";
  const action = options.queued ? "Queued message for" : "Sent message to";
  const timing = options.queued
    ? "The agent is already working and will read this message when ready."
    : "The agent will return with a full answer once he's done.";

  return `${action} ${target} in session ${String(sessionId ?? "")}.\nMessage: ${message}\n${timing} Do not wait for it to return, and do not duplicate the delegated work yourself.`;
}

export function sendStatusText(details: SendCardDetails = {}) {
  if (details.status === "done") return `Agent ${details.agentName ?? ""} answered.`.replace(/\s+/g, " ").trim();

  if (details.status === "queued") return `Queued message for ${details.agentName ?? "agent"}.`;

  if (details.status === "stopped") return details.error ?? "Agent stopped before answering.";

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
}: {
  pi: PiApi;
  ctx: PiContext;
  target: PiRuntimeSession;
  message: string;
  async?: boolean;
  fork?: boolean;
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
  } catch (error) {
    reportRuntimeDiagnostic("send-context-delivery", error);
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
}: ReturnDeliveryParameters) {
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

  if (invoke && (await deliverToInactiveCaller(invokeInactiveCaller, text, "background-return-delivery")))
    return "background";

  persistReturnForCaller({ callerSessionManager, text, invoke, persist });

  return "persisted";
}

export async function deliverCardToCaller({
  pi,
  ctx,
  callerSessionId,
  callerSessionManager,
  text,
  details,
  invoke,
  persist,
  invokeInactiveCaller,
  visibleSession,
  queue,
}: CardDeliveryParameters) {
  const message = {
    customType: CARD_MESSAGE_TYPE,
    content: text,
    display: true,
    details: prepareCardDetailsForHistory(details),
  };
  const liveTarget = liveCallerSession(ctx, callerSessionId, visibleSession);

  try {
    if (liveTarget?.session?.sendCustomMessage) {
      await liveTarget.session.sendCustomMessage(message, customDeliveryOptions(liveTarget.session, invoke, queue));

      return "live";
    }

    if (contextStillActive(ctx, callerSessionId)) {
      pi.sendMessage(message, customDeliveryOptions(ctx, invoke, queue));

      return "live";
    }
  } catch (error) {
    reportRuntimeDiagnostic("live-card-delivery", error);
  }

  if (invoke && (await deliverToInactiveCaller(invokeInactiveCaller, message, "background-card-delivery")))
    return "background";

  try {
    callerSessionManager.appendCustomMessageEntry?.(CARD_MESSAGE_TYPE, text, true, message.details);
    persist?.(callerSessionManager);

    return "persisted";
  } catch (error) {
    reportRuntimeDiagnostic("persisted-card-delivery", error, "warning");
    return "unavailable";
  }
}

export async function deliverToLiveCaller({
  pi,
  ctx,
  callerSessionId,
  text,
  invoke,
  visibleSession,
  queue,
}: Omit<ReturnDeliveryParameters, "callerSessionManager">) {
  const liveTarget = liveCallerSession(ctx, callerSessionId, visibleSession);

  try {
    if (liveTarget) {
      if (
        (invoke || liveTarget.session.isStreaming === true) &&
        typeof liveTarget.session.sendUserMessage === "function"
      ) {
        await liveTarget.session.sendUserMessage(
          text,
          liveTarget.session.isStreaming === true
            ? { deliverAs: queue }
            : sendUserMessageOptions(liveTarget.ctx, queue),
        );

        return { delivered: true, mode: "live" };
      }

      if (typeof liveTarget.session.sendCustomMessage === "function") {
        await liveTarget.session.sendCustomMessage(returnContextMessage(text), {
          triggerTurn: false,
        });

        return { delivered: true, mode: "live" };
      }
    }

    if (!contextStillActive(ctx, callerSessionId)) return { delivered: false };

    if (invoke) pi.sendUserMessage(text, sendUserMessageOptions(ctx, queue));
    else pi.sendMessage(returnContextMessage(text), customMessageOptions(ctx, queue));

    return { delivered: true, mode: "live" };
  } catch (error) {
    reportRuntimeDiagnostic("live-return-delivery", error);
    return { delivered: false };
  }
}

function liveCallerSession(
  ctx: PiContext,
  callerSessionId: string | undefined,
  visibleSession: SessionController | undefined,
) {
  return visibleCallerSession(ctx, callerSessionId, visibleSession) ?? runningCallerSession(callerSessionId, ctx);
}

function visibleCallerSession(
  ctx: PiContext,
  callerSessionId: string | undefined,
  visibleSession: SessionController | undefined,
) {
  if (!visibleSession) return undefined;

  return activeLiveSession(visibleSession, callerSessionId, ctx);
}

function runningCallerSession(callerSessionId: string | undefined, fallbackCtx?: PiContext) {
  const session = callerSessionId ? getRuntimeSession(callerSessionId)?.session : undefined;

  if (session?.isStreaming !== true) return undefined;

  try {
    return { session, ctx: replacedSessionContext(session) ?? fallbackCtx };
  } catch (error) {
    reportRuntimeDiagnostic("running-caller-context", error);
    return { session, ctx: fallbackCtx };
  }
}

function activeLiveSession(session: SessionController | undefined, callerSessionId?: string, fallbackCtx?: PiContext) {
  if (!session) return undefined;

  try {
    const sessionId = session.sessionManager?.getSessionId?.();

    if (callerSessionId && sessionId && sessionId !== callerSessionId) return undefined;

    const ctx = replacedSessionContext(session) ?? fallbackCtx;

    if (ctx && !contextStillActive(ctx, callerSessionId)) return undefined;

    return { session, ctx };
  } catch (error) {
    reportRuntimeDiagnostic("visible-caller-context", error);
    return undefined;
  }
}

function replacedSessionContext(session: SessionController) {
  return typeof session.createReplacedSessionContext === "function"
    ? session.createReplacedSessionContext()
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
}: {
  callerSessionManager: PiSessionManager;
  text: string;
  invoke: boolean;
  persist?: (sessionManager: PiSessionManager) => unknown;
}) {
  if (invoke && typeof callerSessionManager.appendMessage === "function")
    callerSessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
  else
    callerSessionManager.appendCustomMessageEntry?.("pi-gentic:return-context", text, true, { kind: "returnContext" });

  persist?.(callerSessionManager);
}

function waitForSessionTurnEnd(session: SessionController, runtime: ExtensionRuntime, signal?: AbortSignal) {
  if (session.isStreaming !== true) return Promise.resolve();
  const settled = Effect.callback<void, AgentCallFailed>((resume) => {
    const abort = () => resume(Effect.fail(AgentCallFailed.make({ message: "Agent call aborted." })));
    const unsubscribe = session.subscribe((event: unknown) => {
      if (isRecord(event) && event.type === "agent_settled") resume(Effect.yieldNow);
    });

    signal?.addEventListener?.("abort", abort, { once: true });

    return Effect.sync(() => {
      unsubscribe();
      signal?.removeEventListener?.("abort", abort);
    });
  });
  const idle = Effect.suspend(function waitUntilIdle(): Effect.Effect<void> {
    return session.isStreaming !== true
      ? Effect.void
      : Effect.sleep(Duration.millis(250)).pipe(Effect.andThen(Effect.suspend(waitUntilIdle)));
  });

  return runtime.runPromise(Effect.raceFirst(settled, idle));
}

export function promptSessionAndWaitForTurnEnd(
  session: SessionController,
  runtime: ExtensionRuntime,
  prompt: () => Promise<unknown>,
  signal?: AbortSignal,
) {
  if (typeof session.subscribe !== "function") return prompt();

  return runtime.runPromise(
    Effect.callback<void, AgentCallFailed>(function (resume) {
      const dispatcher = this.makeDispatcher();
      let active = true;
      let promptStarted = false;
      let cleanup = () => {};
      const complete = (effect: Effect.Effect<void, AgentCallFailed>) => {
        if (!active) return;
        active = false;
        cleanup();
        resume(effect);
      };
      const abort = () => complete(Effect.fail(AgentCallFailed.make({ message: "Agent call aborted." })));
      const unsubscribe = session.subscribe?.((event: unknown) => {
        if (promptStarted && isRecord(event) && event.type === "agent_settled")
          dispatcher.scheduleTask(() => complete(Effect.void), 0);
      });

      cleanup = () => {
        unsubscribe?.();
        signal?.removeEventListener?.("abort", abort);
      };
      signal?.addEventListener?.("abort", abort, { once: true });
      promptStarted = true;
      void prompt().then(
        () => complete(Effect.void),
        (error: unknown) =>
          complete(
            Effect.fail(
              AgentCallFailed.make({
                message: error instanceof Error ? error.message : String(error),
                cause: error,
              }),
            ),
          ),
      );

      return Effect.sync(() => {
        active = false;
        cleanup();
      });
    }),
  );
}

export function sendUserMessageOptions(ctx: PiContext | undefined, queue: DeliveryQueue = "followUp") {
  try {
    return ctx?.isIdle?.() === false ? { deliverAs: queue } : undefined;
  } catch (error) {
    reportRuntimeDiagnostic("send-user-options", error);
    return undefined;
  }
}

export function isTargetSlashCommand(message: unknown, session: unknown = {}) {
  return Boolean(resolveTargetSlashCommand(message, session));
}

export function resolveTargetSlashCommand(message: unknown, session: unknown = {}) {
  const name = slashCommandName(message);

  if (!name) return undefined;

  return targetSlashCommands(session).find((command) => command.name === name) ?? fallbackSlashCommand(name, session);
}

export async function prepareTargetPromptForSend(session: SessionController, message: string, context: string) {
  const command = resolveTargetSlashCommand(message, session);

  if (!command) return { text: context };
  if (startsAgentTurn(command) && typeof session.sendCustomMessage === "function")
    await session.sendCustomMessage(sendContextMessage(context), {
      triggerTurn: false,
      deliverAs: session.isStreaming === true ? "steer" : "nextTurn",
    });

  return { text: message, command };
}

export function slashCommandDeliveryText(command: UnknownRecord, sessionId: unknown) {
  return [`Command /${command.name} delivered to session`, `${shortSessionId(sessionId)}.`].join(" ");
}

function startsAgentTurn(command: UnknownRecord) {
  return command.source !== "extension";
}

function sendContextMessage(content: string) {
  return {
    customType: "pi-gentic:send-context",
    content,
    display: false,
    details: { kind: "sendContext", slashCommand: true },
  };
}

function slashCommandName(message: unknown) {
  const text = String(message ?? "").trim();
  const match = text.match(/^\/([^\s]+)(?:\s|$)/);

  return match?.[1];
}

function targetSlashCommands(session: unknown) {
  try {
    if (!isRecord(session)) return [];
    const context =
      typeof session.createReplacedSessionContext === "function" ? session.createReplacedSessionContext() : undefined;
    const contextCommands =
      isRecord(context) && typeof context.getCommands === "function" ? context.getCommands() : undefined;
    const commands = contextCommands ?? (typeof session.getCommands === "function" ? session.getCommands() : []);

    return Array.isArray(commands)
      ? commands
          .filter((command) => typeof command?.name === "string" && command.name)
          .map((command) => ({ ...command, name: String(command.name) }))
      : [];
  } catch (error) {
    reportRuntimeDiagnostic("target-slash-commands", error);
    return [];
  }
}

function fallbackSlashCommand(name: string, session: unknown) {
  if (name.startsWith("skill:") && skillNames(session).has(name.slice("skill:".length)))
    return { name, source: "skill" };

  if (promptTemplateNames(session).has(name)) return { name, source: "prompt" };

  return undefined;
}

function skillNames(session: unknown) {
  if (!isRecord(session) || !isRecord(session.resourceLoader)) return new Set<string>();
  const loaded =
    typeof session.resourceLoader.getSkills === "function" ? session.resourceLoader.getSkills() : undefined;
  const skills = isRecord(loaded) ? loaded.skills : undefined;

  return new Set(
    Array.isArray(skills) ? skills.map((skill) => skill?.name).filter((name) => typeof name === "string") : [],
  );
}

function promptTemplateNames(session: unknown) {
  const prompts = isRecord(session) ? session.promptTemplates : undefined;

  return new Set(
    Array.isArray(prompts) ? prompts.map((prompt) => prompt?.name).filter((name) => typeof name === "string") : [],
  );
}

function customMessageOptions(ctx: PiContext, queue: DeliveryQueue = "followUp") {
  return {
    triggerTurn: false,
    ...sendUserMessageOptions(ctx, queue),
  };
}

async function deliverToInactiveCaller<T>(
  deliver: ((value: T) => Promise<unknown>) | undefined,
  value: T,
  diagnosticSource: string,
) {
  if (!deliver) return false;

  try {
    await deliver(value);
    return true;
  } catch (error) {
    reportRuntimeDiagnostic(diagnosticSource, error);
    return false;
  }
}

function customDeliveryOptions(
  target: SessionController | PiContext,
  invoke: boolean,
  queue: DeliveryQueue = "followUp",
) {
  if ("isStreaming" in target && target.isStreaming === true) return { deliverAs: queue };
  if (!("isIdle" in target)) return { triggerTurn: invoke === true };
  const isIdle = target.isIdle;
  const streaming = typeof isIdle === "function" ? isIdle.call(target) === false : isIdle === false;

  return streaming ? { deliverAs: queue } : { triggerTurn: invoke === true };
}

export function persistAgentCardState(
  sessionManager: PiSessionManager,
  details: UnknownRecord,
  persist?: (sessionManager: PiSessionManager) => void,
) {
  if (!details?.cardId || !isTerminalCard(details)) return false;
  if (typeof sessionManager.appendCustomEntry !== "function") return false;
  const snapshot = prepareCardDetailsForHistory(details);
  const decoded = Schema.decodeUnknownExit(PersistedCardDetailsSchema)(snapshot);

  if (Exit.isFailure(decoded)) {
    reportRuntimeDiagnostic("persisted-card-state", decoded.cause, "warning");
    return false;
  }
  sessionManager.appendCustomEntry(CARD_STATE_ENTRY_TYPE, decoded.value);
  setPersistedCardDetails(decoded.value);
  persist?.(sessionManager);

  return true;
}

export function contextStillActive(ctx: PiContext, callerSessionId?: string) {
  try {
    void ctx.cwd;
    const activeSessionId = ctx.sessionManager.getSessionId();

    return !callerSessionId || activeSessionId === callerSessionId;
  } catch (error) {
    reportRuntimeDiagnostic("extension-context-liveness", error);
    return false;
  }
}

export function isStaleExtensionContextError(error: unknown) {
  return getErrorMessage(error).includes("This extension ctx is stale");
}

const MAX_PERSISTED_ACTIVITIES = 100;
const ACTIVITY_PREVIEW_LENGTH = 240;
const ACTIVITY_INSPECT_OPTIONS = { depth: 2, maxArrayLength: 10, maxStringLength: ACTIVITY_PREVIEW_LENGTH } as const;

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

function recordRunResult(runtime: PiRuntimeSession, details: UnknownRecord) {
  runtime.lastActivities = Array.isArray(details.activities)
    ? details.activities.filter(isRecord)
    : (runtime.lastActivities ?? []);
  runtime.runStartedAt = undefined;

  return details;
}

function completeSessionActivities(session: PiAgentSession) {
  return collectSessionActivities(session);
}

export function collectSessionActivities(session: PiAgentSession) {
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

export function mergeActivities(...activityLists: unknown[][]) {
  const merged: UnknownRecord[] = [];
  const indexes = new Map<unknown, number>();

  for (const activity of activityLists.flat().filter(isRecord)) upsertActivity(merged, activity, indexes);

  return merged;
}

export function lastRuntimeActivities(runtime: PiRuntimeSession) {
  return mergeActivities(collectSessionActivities(runtime.session), runtime.lastActivities ?? []);
}

export function latestActivityLines(runtime: PiRuntimeSession, count = 3) {
  return lastRuntimeActivities(runtime).slice(-count).map(formatActivityLine).filter(Boolean);
}

export function formatActivityLine(activity: UnknownRecord | undefined) {
  if (!activity) return undefined;

  if (activity.type === "assistant") return `assistant ${truncateInline(activity.text, 160)}`;
  const status = activity.status ? ` (${activity.status})` : "";

  return `[${activity.name ?? activity.type}] ${truncateInline(activity.summary ?? activity.text ?? "", 160)}${status}`.trim();
}

function eventToActivity(
  event: UnknownRecord,
  projectAssistantDelta: (event: UnknownRecord) => UnknownRecord | undefined = () => undefined,
) {
  if (!event || typeof event !== "object") return undefined;
  const assistantDeltaActivity = projectAssistantDelta(event);

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
  if (typeof message.content === "string") return truncateInline(message.content, ACTIVITY_PREVIEW_LENGTH);
  if (!Array.isArray(message.content)) return "";
  const text = message.content
    .filter((part: UnknownRecord) => part.type === "text" && typeof part.text === "string")
    .slice(0, 10)
    .map((part: UnknownRecord) => String(part.text).slice(0, ACTIVITY_PREVIEW_LENGTH * 4))
    .join("\n");

  return truncateInline(text, ACTIVITY_PREVIEW_LENGTH);
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

export function sessionOutcomeText(
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
  if (!message) return "";
  const text = Array.isArray(message.content)
    ? message.content
        .filter((part: UnknownRecord) => part.type === "text")
        .map((part: UnknownRecord) => part.text)
        .join("\n")
    : message.content;

  return String(text ?? "").trim();
}

export function sessionStatus(runtime: PiRuntimeSession) {
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

export { prepareWorktree };

function registerRuntimeHost(runtimeHost: PiAgentRuntimeHost, metadata: UnknownRecord = {}) {
  const session = runtimeHost.session;
  const sessionManager = session.sessionManager;
  const runtime: PiRuntimeSession = {
    runtimeHost,
    session,
    agentName: getActiveState(sessionManager).agentName,
    parentSessionPath: sessionManager.getHeader?.()?.parentSession,
    ...metadata,
  };

  setRuntimeSession(sessionManager.getSessionId(), runtime);

  return runtime;
}

type DelegationIdentity = {
  readonly delegationId: DelegationIdValue;
  readonly callerSessionId: SessionIdValue;
  readonly targetSessionId: SessionIdValue;
  readonly queuedAt: number;
  readonly startedAt: number;
};

function terminalDelegationState(
  identity: DelegationIdentity,
  result: { answer: string; details: UnknownRecord },
): DelegationState {
  const completedAt = Date.now();
  const reason = String(result.details.error ?? result.answer);

  if (result.details.status === "done")
    return DelegationCompleted.make({
      ...identity,
      completedAt,
      answer: result.answer,
    });
  if (result.details.status === "aborted") return DelegationAborted.make({ ...identity, completedAt, reason });
  if (result.details.status === "stopped") return DelegationStopped.make({ ...identity, completedAt, reason });
  return DelegationFailed.make({ ...identity, completedAt, reason });
}

function isCustomPiMessage(value: unknown): value is {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
} {
  return (
    isRecord(value) &&
    typeof value.customType === "string" &&
    typeof value.content === "string" &&
    typeof value.display === "boolean"
  );
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && ["minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

export function branchForkBeforeDelegation(
  sessionManager: Pick<SessionManager, "branch" | "getEntry" | "getLeafId" | "resetLeaf">,
  call: unknown,
) {
  if (!isRecord(call)) return false;
  const callerEntryId = call.callerEntryId;
  const forkBoundaryEntryId = call.forkBoundaryEntryId;
  const toolCallId = call.toolCallId;

  if (
    typeof callerEntryId !== "string" ||
    (forkBoundaryEntryId !== null && typeof forkBoundaryEntryId !== "string") ||
    typeof toolCallId !== "string" ||
    sessionManager.getLeafId() !== callerEntryId
  )
    return false;
  const entry = sessionManager.getEntry(callerEntryId);

  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return false;
  const content = Array.isArray(entry.message.content) ? entry.message.content : [];
  const isDelegationTurn = content.some(
    (block) => isRecord(block) && block.type === "toolCall" && block.name === "agents" && block.id === toolCallId,
  );

  if (!isDelegationTurn) return false;
  if (forkBoundaryEntryId === null) sessionManager.resetLeaf();
  else sessionManager.branch(forkBoundaryEntryId);

  return true;
}

export class PiGenticOrchestrator {
  pi: PiApi;
  currentAgentName?: string;
  runtime: ExtensionRuntime;
  private readonly toolPolicyStates = new WeakMap<PiSessionManager, ToolPolicyState>();

  constructor(pi: PiApi, runtime: ExtensionRuntime) {
    this.pi = pi;
    this.runtime = runtime;
    this.currentAgentName = undefined;
  }

  load(ctx: PiContext) {
    return loadConfiguration({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted?.() === true,
    });
  }

  getActiveAgent(ctx: PiContext, config: Configuration = this.load(ctx)) {
    const state = getActiveState(ctx.sessionManager);

    return config.agents.find((agent) => agent.name === state.agentName);
  }

  resolvePolicy(
    ctx: PiContext,
    config: Configuration = this.load(ctx),
    state = getActiveState(ctx.sessionManager),
    resources: { tools?: string[]; skills?: string[] } = {},
  ) {
    const activeAgent = config.agents.find((agent) => agent.name === state.agentName);

    return resolveSessionPolicy({
      settings: config.settings,
      activeAgent,
      overrides: state.overrides,
      allAgents: config.agents.map((agent) => agent.name),
      allTools: resources.tools ?? this.pi.getAllTools().map((tool) => tool.name),
      allSkills: resources.skills ?? currentSkillNames(ctx),
    });
  }

  availableAgents(ctx: PiContext, config: Configuration = this.load(ctx)) {
    return filterAvailableAgents(config, this.resolvePolicy(ctx, config));
  }

  assertAgentAvailable(ctx: PiContext, agentName: unknown, config: Configuration = this.load(ctx)) {
    const configured = config.agents.find(
      (agent) => agent.name.toLowerCase() === String(agentName ?? "").toLowerCase(),
    );

    if (!configured)
      throw new Error(
        `Unknown agent "${agentName}". Available agents: ${config.agents.map((agent) => agent.name).join(", ") || "none"}.`,
      );

    return assertAvailableAgent(agentName, this.availableAgents(ctx, config));
  }

  async applyCurrentPolicy(ctx: PiContext, options: { running?: boolean } = {}) {
    const { config, policy: resolvedPolicy } = this.resolveCurrentPolicy(ctx, {
      skills: skillContext(ctx).names,
    });

    if (resolvedPolicy.model) {
      const model = this.resolveModel(ctx, resolvedPolicy.model);

      if (model) await this.pi.setModel(model);
    }

    if (isThinkingLevel(resolvedPolicy.thinking)) this.pi.setThinkingLevel(resolvedPolicy.thinking);

    if (resolvedPolicy.theme && ctx.mode === "tui") ctx.ui.setTheme(resolvedPolicy.theme);
    const policy = this.reconcileVisibleToolPolicy(ctx, resolvedPolicy);
    this.setTitle(ctx, options.running === true);
    this.setAgentWidget(ctx);

    return { config, policy };
  }

  applyCurrentToolPolicy(ctx: PiContext, resources: { skills?: string[] } = {}) {
    const { config, policy: resolvedPolicy, activeAgent } = this.resolveCurrentPolicy(ctx, resources);
    const policy = this.reconcileVisibleToolPolicy(ctx, resolvedPolicy);

    return { config, policy, activeAgent };
  }

  private resolveCurrentPolicy(ctx: PiContext, resources: { skills?: string[] } = {}) {
    const config = this.load(ctx);
    const state = getActiveState(ctx.sessionManager);
    const activeAgent = config.agents.find((agent) => agent.name === state.agentName);
    const policy = this.resolvePolicy(ctx, config, state, resources);

    return { config, policy, activeAgent };
  }

  private reconcileVisibleToolPolicy(ctx: PiContext, policy: SessionPolicy) {
    const tools = this.reconcileSessionTools(
      ctx.sessionManager,
      this.pi.getAllTools().map((tool) => tool.name),
      this.pi.getActiveTools(),
      policy.toolFilters,
      (selection) => this.pi.setActiveTools(selection),
    );
    const effectivePolicy = { ...policy, resources: { ...policy.resources, tools } };

    this.currentAgentName = effectivePolicy.agentName;

    return effectivePolicy;
  }

  private reconcileSessionTools(
    sessionManager: PiSessionManager,
    registeredToolNames: ReadonlyArray<string>,
    observedToolNames: ReadonlyArray<string>,
    filters: ReadonlyArray<string> | undefined,
    apply: (selection: Array<string>) => void,
  ) {
    const reconciliation = reconcileActiveToolSelection({
      registeredToolNames,
      observedToolNames,
      filters,
      previousState: this.toolPolicyStates.get(sessionManager),
    });

    if (reconciliation.changed) apply(reconciliation.selection);
    this.toolPolicyStates.set(sessionManager, reconciliation.state);

    return reconciliation.selection;
  }

  setTitle(ctx: PiContext, running = false) {
    const agent = activeAgentName(ctx.sessionManager);

    if (agent) ctx.ui.setTitle(`${running ? "●" : "○"} ${agent}`);
  }

  setAgentWidget(ctx: PiContext) {
    setAgentLabel(ctx, activeAgentName(ctx.sessionManager));
  }

  prepareVisibleTurn(ctx: PiContext) {
    try {
      return this.applyCurrentToolPolicy(ctx);
    } catch (error) {
      if (isStaleExtensionContextError(error)) return undefined;
      throw error;
    }
  }

  buildPromptAppend(ctx: PiContext, event: { systemPrompt: string }) {
    try {
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
    } catch (error) {
      if (isStaleExtensionContextError(error)) return undefined;
      throw error;
    }
  }

  applyPolicySnapshot(ctx: PiContext, resources: { skills?: string[] } = {}) {
    const config = this.load(ctx);
    const state = getActiveState(ctx.sessionManager);
    const activeAgent = config.agents.find((agent) => agent.name === state.agentName);
    const policy = this.resolvePolicy(ctx, config, state, {
      tools: this.pi.getActiveTools(),
      skills: resources.skills ?? skillContext(ctx).names,
    });
    this.currentAgentName = policy.agentName;

    return { config, policy, activeAgent };
  }

  async loadDefaultAgent(ctx: PiContext, event: { reason?: string }) {
    const config = this.load(ctx);
    const agentName = configuredDefaultAgent(config.settings);

    if (!agentName || !shouldApplyDefaultAgent(event, ctx.sessionManager)) return undefined;

    if (!config.agents.some((agent) => agent.name.toLowerCase() === agentName.toLowerCase())) {
      ctx.ui.notify(`pi-gentic defaultAgent "${agentName}" is not configured.`, "warning");
      await this.applyCurrentPolicy(ctx);

      return undefined;
    }

    return this.loadAgent(ctx, agentName, { enforceAccess: false });
  }

  async cycleAgent(ctx: PiContext) {
    const config = this.load(ctx);
    const agentName = nextAgentName(activeAgentName(ctx.sessionManager), config.agents);

    return this.loadAgent(ctx, agentName ?? "clear");
  }

  async loadAgent(ctx: PiContext, agentName: unknown, options: UnknownRecord = {}) {
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
          systemPrompt: this.resolvedPromptForCard(ctx, config, policy, undefined),
        }),
      };
    }

    const agent =
      options.enforceAccess === false
        ? config.agents.find((item) => String(item.name).toLowerCase() === String(agentName).toLowerCase())
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

  resolvedPromptForCard(
    ctx: PiContext,
    config: Configuration,
    policy: SessionPolicy,
    activeAgent: AgentDefinition | undefined,
  ) {
    const baseSystemPrompt = safeSystemPrompt(ctx);

    return buildResolvedSystemPrompt({
      baseSystemPrompt,
      config: { ...config, activeAgent },
      policy,
      skillEntries: skillContext(ctx, parseSkillEntries(baseSystemPrompt)).entries,
    });
  }

  async send(ctx: PiContext, input: SendInput, callbacks: SendCallbacks = {}) {
    const config = this.load(ctx);

    if (input.agent) this.assertAgentAvailable(ctx, input.agent, config);
    const callerState = getActiveState(ctx.sessionManager);
    const callerAgent = callerState.agentName;
    const callerActor = callerAgent ? `[${callerAgent}] agent` : "caller session";
    const defaults = this.resolvePolicy(ctx, config, callerState).agentsTool;
    const invokeDefaults = isRecord(defaults.invokeMeLater) ? defaults.invokeMeLater : {};
    const targetAsync = input.sessionId ? true : chooseBoolean(input.async, chooseBoolean(defaults.async, false));
    const targetFork = chooseBoolean(input.fork, chooseBoolean(defaults.fork, false));
    const cwd = await this.resolveSendCwd(ctx, {
      ...input,
      cwd: input.cwd ?? (typeof defaults.cwd === "string" ? defaults.cwd : undefined),
    });
    const invokeMeLater = chooseBoolean(
      input.invokeMeLater,
      targetAsync ? invokeDefaults.async !== false : invokeDefaults.withSession !== false,
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
      { call: callbacks.call },
    );
    const targetSessionId = target.session.sessionManager.getSessionId();
    const targetBusy = target.session.isStreaming === true;
    const readyAt = Date.now();
    const callerSessionManager = ctx.sessionManager;
    const callerSessionId = callerSessionManager.getSessionId();
    const runtimeMetadata = RuntimeMetadata.make({
      sessionId: Schema.decodeUnknownSync(SessionId)(targetSessionId),
      parentSessionId: Schema.decodeUnknownSync(SessionId)(callerSessionId),
      createdAt: readyAt,
      lastActivityAt: readyAt,
      ...(target.agentName
        ? {
            agentName: Schema.decodeUnknownSync(AgentName)(target.agentName),
          }
        : {}),
    });
    await this.runtime.runPromise(
      Effect.flatMap(RuntimeRegistry, (registry) => registry.register(runtimeMetadata, target)),
    );
    const callerCwd = ctx.cwd;
    const call = callbacks.call
      ? {
          ...callbacks.call,
          effectiveParameters: {
            ...(isRecord(callbacks.call.parameters) ? callbacks.call.parameters : {}),
            action: "send",
            async: targetAsync,
            fork: targetFork,
            cwd,
          },
        }
      : undefined;
    const details = this.cardDetails("send", targetBusy ? "queued" : "running", {
      cardId: `send:${targetSessionId}:${startedAt}`,
      livePanel: true,
      callerSessionId,
      async: targetAsync,
      agentName: target.agentName,
      sessionId: targetSessionId,
      message: input.message,
      queued: targetBusy,
      startedAt,
      updatedAt: readyAt,
      activities: [],
      ...(call ? { call } : {}),
    });
    target.session.sessionManager.appendCustomMessageEntry?.(
      CARD_MESSAGE_TYPE,
      targetFork
        ? `Fork boundary from session ${shortSessionId(callerSessionId)}.`
        : `Delegated from session ${shortSessionId(callerSessionId)}.`,
      true,
      this.cardDetails("delegation", "done", {
        callerSessionId,
        callerSessionPath: callerSessionManager.getSessionFile(),
        sessionId: targetSessionId,
        ...(call ? { call } : {}),
      }),
    );
    persistSessionImmediately(target.session.sessionManager);
    let terminalStatePersisted = false;
    const publish = (nextDetails: UnknownRecord, options: UnknownRecord = {}) => {
      const liveDetails = setLiveCardDetails(nextDetails, { runtime: this.runtime }) ?? nextDetails;

      if (!terminalStatePersisted && returnDelivery.kind === "callerMessage")
        terminalStatePersisted = persistAgentCardState(callerSessionManager, liveDetails, persistSessionImmediately);

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
    const delegationId = Schema.decodeUnknownSync(DelegationId)(
      `delegation:${callerSessionId}:${targetSessionId}:${startedAt}`,
    );
    let aborting = false;
    const abortTarget = async (options: UnknownRecord = {}) => {
      if (aborting) return;
      aborting = true;
      try {
        target.lastAbort = {
          actor: typeof options.actor === "string" ? options.actor : callerActor,
          at: Date.now(),
        };
        if (options.skipSessionAbort !== targetSessionId) await target.session.abort();
      } finally {
        aborting = false;
      }
    };
    const activeCall = registerAgentCall({
      id: delegationId,
      callerSessionId,
      targetSessionId,
      isCancellable: () => target.session.isStreaming === true,
      abort: async (options: UnknownRecord = {}) => {
        await abortTarget(options);
        await this.runtime.runPromise(Effect.flatMap(DelegationFibers, (fibers) => fibers.abort(delegationId)));
      },
    });
    const runAbort = (scope: string, operation: () => Promise<unknown>) => {
      try {
        this.runtime.runFork(
          Effect.tryPromise({
            try: operation,
            catch: (cause) => AgentCallFailed.make({ message: getErrorMessage(cause), cause }),
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                reportRuntimeDiagnostic(scope, error);
              }),
            ),
          ),
        );
      } catch (error) {
        reportRuntimeDiagnostic(scope, error);
      }
    };
    const abortFromSignal = () => runAbort("delegation-signal-abort", () => abortTarget({ actor: callerActor }));
    callbacks.signal?.addEventListener?.("abort", abortFromSignal, {
      once: true,
    });
    const run = async (operationSignal?: AbortSignal) => {
      const abortFromOperation = () =>
        runAbort("delegation-operation-abort", () => abortAgentCall(activeCall.id, { actor: callerActor }));
      operationSignal?.addEventListener("abort", abortFromOperation, {
        once: true,
      });
      target.runStartedAt ??= readyAt;
      target.lastActivityAt = new Date(readyAt).toISOString();
      const monitor = createSessionActivityMonitor(details, (nextDetails) => {
        target.lastActivityAt = new Date(
          typeof nextDetails.updatedAt === "number" ? nextDetails.updatedAt : Date.now(),
        ).toISOString();
        target.lastActivities = Array.isArray(nextDetails.activities)
          ? nextDetails.activities.filter(isRecord)
          : (target.lastActivities ?? []);

        return publish(nextDetails);
      });
      const unsubscribe =
        typeof target.session.subscribe === "function"
          ? target.session.subscribe((event: unknown) => monitor.observe(event))
          : undefined;

      try {
        const receipt = buildReceiptText(callerAgent, callerSessionId, input.message);
        const targetPrompt = await prepareTargetPromptForSend(target.session, input.message, receipt);
        await promptSessionAndWaitForTurnEnd(
          target.session,
          this.runtime,
          () =>
            target.session.prompt(
              targetPrompt.text,
              target.session.isStreaming ? { streamingBehavior: "steer" } : undefined,
            ),
          callbacks.signal,
        );
        if (targetPrompt.command && !startsAgentTurn(targetPrompt.command)) {
          const answer = slashCommandDeliveryText(targetPrompt.command, targetSessionId);
          const completed = recordRunResult(
            target,
            monitor.finish({
              answer,
              activities: completeSessionActivities(target.session),
            }),
          );

          return { answer, details: completed };
        }
        if (targetBusy) await waitForSessionTurnEnd(target.session, this.runtime, callbacks.signal);
        const outcome = sessionRunOutcome(target, { request: input.message });
        const completed = recordRunResult(
          target,
          outcome.status === "done"
            ? monitor.finish({
                answer: outcome.text,
                activities: completeSessionActivities(target.session),
              })
            : monitor.stop(outcome.status, {
                error: outcome.text,
                activities: completeSessionActivities(target.session),
              }),
        );
        const returnText =
          outcome.status === "done" ? buildReturnText(target.agentName, targetSessionId, outcome.text) : outcome.text;
        if (returnDelivery.kind === "callerMessage") {
          await this.deliverCallerCard(ctx, {
            callerSessionId,
            callerSessionManager,
            callerCwd,
            config,
            text: returnText,
            details: completed,
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
        const failed = recordRunResult(
          target,
          monitor.stop(outcome.status, {
            error: outcome.text,
            activities: completeSessionActivities(target.session),
          }),
        );
        if (returnDelivery.kind === "callerMessage")
          await this.deliverCallerCard(ctx, {
            callerSessionId,
            callerSessionManager,
            callerCwd,
            config,
            text: outcome.text,
            details: failed,
            invoke: invokeMeLater,
            queue: returnDelivery.queue,
          });

        return { answer: outcome.text, details: failed };
      } finally {
        unsubscribe?.();
        setRuntimeSession(targetSessionId, target);
        callbacks.signal?.removeEventListener?.("abort", abortFromSignal);
        operationSignal?.removeEventListener("abort", abortFromOperation);
        activeCall.unregister();

        if (target.session.isStreaming !== true) {
          unregisterLiveRuntime(targetSessionId);
          try {
            await this.runtime.runPromise(
              Effect.flatMap(RuntimeRegistry, (registry) => registry.remove(runtimeMetadata.sessionId)),
            );
          } catch (error) {
            reportRuntimeDiagnostic("runtime-registry-removal", error);
          }
        }
        pruneRuntimeSessions();
      }
    };

    if (returnDelivery.kind === "callerMessage") {
      const identity = {
        delegationId,
        callerSessionId: Schema.decodeUnknownSync(SessionId)(callerSessionId),
        targetSessionId: Schema.decodeUnknownSync(SessionId)(targetSessionId),
        queuedAt: startedAt,
        startedAt: readyAt,
      };
      const operation = Effect.tryPromise<DelegationState, string>({
        try: async (signal) => terminalDelegationState(identity, await run(signal)),
        catch: getErrorMessage,
      }).pipe(
        Effect.catch((message) =>
          Effect.tryPromise({
            try: () =>
              this.deliverCallerCard(ctx, {
                callerSessionId,
                callerSessionManager,
                callerCwd,
                config,
                text: message,
                details: this.cardDetails("send", "error", {
                  ...details,
                  status: "error",
                  error: message,
                  completedAt: Date.now(),
                  updatedAt: Date.now(),
                }),
                invoke: false,
                queue: returnDelivery.queue,
              }),
            catch: getErrorMessage,
          }).pipe(
            Effect.ignore,
            Effect.as(
              DelegationFailed.make({
                ...identity,
                completedAt: Date.now(),
                reason: message,
              }),
            ),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            callbacks.onSettled?.();
          }),
        ),
      );

      await this.runtime.runPromise(Effect.flatMap(DelegationFibers, (fibers) => fibers.run(delegationId, operation)));

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

  async resolveSendCwd(ctx: PiContext, input: SendInput) {
    if (input.worktree === undefined) return input.cwd ?? ctx.cwd;

    return this.prepareWorktree(ctx, input);
  }

  async prepareWorktree(ctx: PiContext, input: SendInput) {
    const automaticSource = input.worktree === true && input.repo === undefined ? input.cwd : undefined;

    return this.runtime.runPromise(
      prepareWorktreeEffect({
        ...input,
        repoCwd: ctx.cwd,
        ...(automaticSource === undefined ? {} : { repo: automaticSource, cwd: undefined }),
        worktree: input.worktree === true ? "" : input.worktree,
      }),
    );
  }

  async applyRequestedTargetPolicy(session: PiAgentSession, input: SendInput, config: Configuration) {
    if (input.agent) return this.loadAgentIntoSession(session, input.agent, input.overrides, config);

    if (input.overrides) return this.applySessionOverrides(session, input.overrides, config);
  }

  async resolveTargetSession(
    ctx: PiContext,
    input: SendInput,
    config: Configuration,
    options: { call?: UnknownRecord } = {},
  ): Promise<PiRuntimeSession> {
    if (input.sessionId) {
      const session = await this.getOrOpenSession(ctx, input.sessionId, input.cwd);
      const callerSessionId = ctx.sessionManager.getSessionId();
      const targetSessionId = session.session.sessionManager.getSessionId();

      assertDifferentSession(callerSessionId, targetSessionId);
      assertNoAgentCallCycle(callerSessionId, targetSessionId);
      await this.assertCanMessageSession(ctx, session, config);

      await this.applyRequestedTargetPolicy(session.session, input, config);

      return session;
    }

    const session = await this.createChildSession(ctx, input, config, options);

    await this.applyRequestedTargetPolicy(session.session, input, config);

    if (!input.agent && !input.overrides)
      await this.applyAgentlessPolicyToNewSession(session.session, config, ctx.model);

    if (typeof input.agent === "string") session.agentName = input.agent;

    return session;
  }

  async assertCanCreateChildSession(ctx: PiContext, config: Configuration) {
    const policy = this.resolvePolicy(ctx, config);
    const currentDepth = await this.currentSessionDepth(ctx);

    return assertCanCreateSubagent({
      currentDepth,
      maxSubagentDepth: policy.maxSubagentDepth,
      globalMaxSubagentDepth: config.settings.globalMaxSubagentDepth,
    });
  }

  async assertCanMessageSession(ctx: PiContext, target: PiRuntimeSession, config: Configuration) {
    if (config.settings.sessionMessagingScope === "all") return;
    const sessionDir = ctx.sessionManager.getSessionDir();
    const persisted = await listDiscoverySessionSources(ctx.cwd, sessionDir);

    assertSessionMessagingScope(
      currentSessionSummary(ctx),
      runtimeSessionSummary(target),
      [...persisted, ...listRuntimeSessions().map(runtimeSessionSummary)],
      { scope: config.settings.sessionMessagingScope },
    );
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
    input: SendInput,
    config: Configuration = this.load(ctx),
    options: { call?: UnknownRecord } = {},
  ): Promise<PiRuntimeSession> {
    let sessionManager;
    const sessionDir = ctx.sessionManager.getSessionDir();
    persistSessionImmediately(ctx.sessionManager);
    await this.assertCanCreateChildSession(ctx, config);
    const parentSessionId = ctx.sessionManager.getSessionId();
    const parentSession = ctx.sessionManager.getSessionFile();

    if (input.fork && parentSession) {
      sessionManager = SessionManager.forkFrom(parentSession, input.cwd ?? ctx.cwd, sessionDir);
      branchForkBeforeDelegation(sessionManager, options.call);
    } else {
      sessionManager = SessionManager.create(input.cwd ?? ctx.cwd, sessionDir, {
        parentSession,
      });
    }

    if (typeof sessionManager.appendSessionInfo === "function") sessionManager.appendSessionInfo(input.message);
    persistSessionImmediately(sessionManager);
    const runtimeHost = await createLiveRuntime({
      cwd: input.cwd ?? ctx.cwd,
      sessionManager,
    });
    const runtime: PiRuntimeSession = {
      runtimeHost,
      session: runtimeHost.session,
      agentName: undefined,
      parentSessionId,
      parentSessionPath: parentSession,
      lastMessage: input.message,
      createdAt: new Date().toISOString(),
    };
    setRuntimeSession(runtimeHost.session.sessionManager.getSessionId(), runtime);

    return runtime;
  }

  async getOrOpenSession(ctx: PiContext, reference: unknown, cwd?: string): Promise<PiRuntimeSession> {
    const runtimeMatches = listRuntimeSessions().filter((runtime) =>
      matchesSession(runtime.session.sessionManager.getSessionId(), reference),
    );
    const runtimeIds = new Set(runtimeMatches.map((runtime) => runtime.session.sessionManager.getSessionId()));

    if (runtimeIds.size === 1) {
      const runtime = runtimeMatches[0];
      if (runtime) return runtime;
    }

    if (runtimeIds.size > 1)
      throw new Error(`Ambiguous session reference "${reference}" matches ${runtimeIds.size} sessions.`);
    const listedSessions = await SessionManager.list(cwd ?? ctx.cwd, ctx.sessionManager.getSessionDir());
    const sessions = listedSessions.flatMap((session) => (isRecord(session) ? [session] : []));
    const resolved = resolveSessionReference(sessions, reference);
    if (!resolved || typeof resolved.path !== "string")
      throw new Error(`Session "${String(reference)}" has no persisted path.`);
    const sessionManager = SessionManager.open(resolved.path, ctx.sessionManager.getSessionDir(), cwd);
    const runtimeHost = await createLiveRuntime({
      cwd: cwd ?? sessionManager.getCwd(),
      sessionManager,
    });

    return registerRuntimeHost(runtimeHost);
  }

  async loadAgentIntoSession(
    session: PiAgentSession,
    agentName: string,
    overrides: unknown,
    config: Configuration,
    accessContext?: PiContext,
  ) {
    const agent = accessContext
      ? this.assertAgentAvailable(accessContext, agentName, config)
      : config.agents.find((item) => item.name.toLowerCase() === agentName.toLowerCase());

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

  async applySessionOverrides(session: PiAgentSession, overrides: unknown, config: Configuration) {
    const state = getActiveState(session.sessionManager);

    appendActiveState(session.sessionManager, {
      agentName: state.agentName,
      overrides,
    });

    return this.applyPolicyToAgentSession(session, config);
  }

  async applyPolicyToAgentSession(session: PiAgentSession, config: Configuration) {
    const resolvedPolicy = this.resolveAgentSessionPolicy(session, config);

    if (resolvedPolicy.model) {
      const model = resolveModelFromCatalog(session.modelRuntime, resolvedPolicy.model);

      if (model) await session.setModel(model);
    }

    if (isThinkingLevel(resolvedPolicy.thinking)) session.setThinkingLevel(resolvedPolicy.thinking);
    const tools = this.reconcileSessionTools(
      session.sessionManager,
      session.getAllTools().map((tool) => tool.name),
      session.getActiveToolNames(),
      resolvedPolicy.toolFilters,
      (selection) => session.setActiveToolsByName(selection),
    );

    return { ...resolvedPolicy, resources: { ...resolvedPolicy.resources, tools } };
  }

  async applyAgentlessPolicyToNewSession(
    session: PiAgentSession,
    config: Configuration,
    inheritedModel: NonNullable<PiContext["model"]> | undefined,
  ) {
    const policy = await this.applyPolicyToAgentSession(session, config);
    await applyInheritedModel(session, policy, inheritedModel);

    return policy;
  }

  resolveAgentSessionPolicy(session: PiAgentSession, config: Configuration) {
    const state = getActiveState(session.sessionManager);
    const activeAgent = config.agents.find((agent) => agent.name === state.agentName);

    return resolveSessionPolicy({
      settings: config.settings,
      activeAgent,
      overrides: state.overrides,
      allAgents: config.agents.map((agent) => agent.name),
      allTools: session.getAllTools().map((tool) => tool.name),
      allSkills: session.resourceLoader.getSkills().skills.map((skill) => skill.name),
    });
  }

  async status(ctx: PiContext, sessionId: unknown) {
    if (!sessionId) throw new Error('Field "sessionId" is required for status.');
    const runtime = await this.getOrOpenSession(ctx, sessionId);

    return sessionStatus(runtime);
  }

  async abort(ctx: PiContext, sessionId: unknown) {
    if (!sessionId) {
      ctx.abort();

      return `Aborted session ${shortSessionId(ctx.sessionManager.getSessionId())}.`;
    }

    const runtime = await this.getOrOpenSession(ctx, sessionId);
    runtime.lastAbort = { actor: abortActor(ctx), at: Date.now() };
    await runtime.session.abort();

    return `Aborted session ${shortSessionId(runtime.session.sessionManager.getSessionId())}.`;
  }

  async deliverCallerCard(
    ctx: PiContext,
    { callerSessionId, callerSessionManager, callerCwd, config, text, details, invoke, queue }: CallerCardParameters,
  ) {
    return deliverCardToCaller({
      pi: activeVisibleExtension() ?? this.pi,
      ctx: activeVisibleContext() ?? ctx,
      callerSessionId,
      callerSessionManager,
      text,
      details,
      invoke,
      persist: persistSessionImmediately,
      visibleSession: activeVisibleSession(),
      queue,
      invokeInactiveCaller: (message: unknown) =>
        this.invokeCallerSession({
          callerSessionManager,
          callerCwd,
          message,
          config,
          queue,
        }),
    });
  }

  async invokeCallerSession({
    callerSessionManager,
    callerCwd,
    message,
    config,
    queue = "steer",
  }: CallerInvocationParameters) {
    const sessionId = callerSessionManager.getSessionId();
    const existing = findRuntimeSession((runtime) => runtime.session.sessionManager.getSessionId() === sessionId);
    const runtime = await this.runtimeForCallerInvocation({
      existing,
      callerSessionManager,
      callerCwd,
    });

    await this.applyPolicyToAgentSession(runtime.session, config);
    if (!isCustomPiMessage(message)) throw new Error("Caller delivery requires a structured Pi message.");
    runtime.lastMessage = String(message.content ?? "");
    runtime.lastActivityAt = new Date().toISOString();
    void runtime.session
      .sendCustomMessage(message, customDeliveryOptions(runtime.session, true, queue))
      .catch((error: unknown) => {
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

  async runtimeForCallerInvocation({
    existing,
    callerSessionManager,
    callerCwd,
  }: {
    existing?: PiRuntimeSession;
    callerSessionManager: PiSessionManager;
    callerCwd: string;
  }) {
    return existing?.session?.isStreaming === true
      ? existing
      : this.createRuntimeForSessionManager(callerSessionManager, callerCwd);
  }

  async createRuntimeForSessionManager(sessionManager: PiSessionManager, cwd?: string): Promise<PiRuntimeSession> {
    persistSessionImmediately(sessionManager);
    const runtimeHost = await createLiveRuntime({
      cwd: cwd ?? sessionManager.getCwd(),
      sessionManager,
    });

    return registerRuntimeHost(runtimeHost, {
      createdAt: new Date().toISOString(),
    });
  }

  async discoverSessions(ctx: PiContext, input: { rx?: number; ry?: number; all?: boolean }) {
    const policy = this.resolvePolicy(ctx, this.load(ctx));
    const rx = parseIntegerRadius(input.rx, "rx", typeof policy.agentsTool.rx === "number" ? policy.agentsTool.rx : 0);
    const ry = parseIntegerRadius(input.ry, "ry", typeof policy.agentsTool.ry === "number" ? policy.agentsTool.ry : 0);
    const current = currentSessionSummary(ctx);
    const sessionDir = ctx.sessionManager.getSessionDir();
    const persisted = await listDiscoverySessionSources(ctx.cwd, sessionDir);
    const tree = buildSessionTree(current, persisted, listRuntimeSessions());
    const related = sessionDiscoveryScope(tree, current ?? {}, {
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

  resolveModel(ctx: PiContext, modelName: string) {
    return resolveModelFromCatalog(ctx.modelRegistry, modelName);
  }

  cardDetails(kind: string, status: string, details: UnknownRecord = {}) {
    return { kind, status, updatedAt: Date.now(), ...details };
  }
}

async function listDiscoverySessionSources(cwd: string, sessionDir?: string) {
  const sessions = await SessionManager.list(cwd, sessionDir);

  return sessions.flatMap((session) => (isRecord(session) ? [session] : []));
}

function currentSkillNames(ctx: PiContext) {
  try {
    return (
      ctx
        .getSystemPromptOptions?.()
        .skills?.map((skill) => skill.name)
        .filter((name): name is string => typeof name === "string") ?? []
    );
  } catch (error) {
    reportRuntimeDiagnostic("current-skill-names", error);
    return [];
  }
}

function skillContext(ctx: PiContext, parsedEntries: UnknownRecord[] = []) {
  const entries = mergeSkillEntries(
    systemPromptSkillEntries(ctx),
    mergeSkillEntries(
      loadAvailableSkills({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted?.() === true,
      }),
      parsedEntries,
    ),
  );
  const names = entries.map((skill) => skill.name).filter((name): name is string => typeof name === "string");

  return { entries, names: names.length > 0 ? names : currentSkillNames(ctx) };
}

function safeSystemPrompt(ctx: PiContext) {
  try {
    return ctx.getSystemPrompt?.() ?? "";
  } catch (error) {
    reportRuntimeDiagnostic("current-system-prompt", error);
    return "";
  }
}

function compactPolicy(policy: SessionPolicy) {
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

function matchesSession(sessionId: unknown, reference: unknown) {
  const id = String(sessionId).toLowerCase();
  const query = String(reference).toLowerCase();

  return id === query || id.startsWith(query) || id.includes(query) || shortSessionId(id) === query;
}
