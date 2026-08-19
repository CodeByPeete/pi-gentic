import { Duration, Effect, Exit, Schema } from "effect";
import { getActiveState } from "../agents/activation.js";
import { recoverDiagnostic, reportRuntimeDiagnostic } from "../shared/diagnostics.js";
import type { DelegationId } from "../delegation/runs.js";
import { getRuntimeSession } from "../pi/sessions.js";
import { awaitJoinedDelegations } from "./runs.js";
import type {
  PiAgentSession,
  PiRuntimeSession,
  PiApi,
  PiContext,
  PiSessionManager,
  ReturnDeliveryGroup,
} from "../pi/types.js";
import type { ExtensionRuntime } from "../extension-runtime.js";
import type { UnknownRecord } from "../shared/values.js";

import { isRecord, shortSessionId } from "../shared/values.js";
import {
  CARD_MESSAGE_TYPE,
  CARD_STATE_ENTRY_TYPE,
  PersistedCardDetailsSchema,
  isTerminalCard,
  prepareCardDetailsForHistory,
  setPersistedCardDetails,
} from "../ui/cards.js";
export class AgentCallFailed extends Schema.TaggedErrorClass<AgentCallFailed>()("AgentCallFailed", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface SendCompletionOptions {
  async?: boolean;
  awaitCompletion?: boolean;
}

export interface SendCardDetails extends UnknownRecord {
  status?: string;
  agentName?: string;
  error?: string;
}

export type DeliveryQueue = "followUp" | "steer";

type SessionController = Pick<
  PiAgentSession,
  "isStreaming" | "sessionManager" | "subscribe" | "sendCustomMessage" | "sendUserMessage"
> & { createReplacedSessionContext?: () => PiContext };

interface CardDeliveryParameters {
  pi: PiApi;
  ctx: PiContext;
  callerSessionId?: string;
  callerSessionManager: PiSessionManager;
  text: string;
  details: UnknownRecord;
  invoke: boolean;
  persist?: (sessionManager: PiSessionManager) => unknown;
  invokeInactiveCaller?: (message: unknown) => Promise<unknown>;
  visibleSession?: SessionController;
  queue?: DeliveryQueue;
}

export function abortActor(ctx: PiContext) {
  return recoverDiagnostic(
    "abort-actor",
    () => {
      const agentName = getActiveState(ctx.sessionManager).agentName;
      return agentName ? `[${agentName}] agent` : "caller session";
    },
    () => "caller session",
  );
}

export function shouldDeferSendCompletion({ async, awaitCompletion }: SendCompletionOptions = {}) {
  return async === true || awaitCompletion === false;
}

export function resolveReturnDelivery(
  options: SendCompletionOptions = {},
): { kind: "callerMessage"; queue: DeliveryQueue } | { kind: "toolResult"; queue?: undefined } {
  return shouldDeferSendCompletion(options) ? { kind: "callerMessage", queue: "steer" } : { kind: "toolResult" };
}

type ReturnDeliveryMembership = {
  readonly owner: boolean;
  readonly accept: () => void;
  readonly release: () => void;
};

/** Shares one visible Return Delivery across Delegations accepted by the same Target Session run. */
export function joinReturnDeliveryGroup({
  target,
  callerSessionId,
  targetBusy,
  shared,
}: {
  target: PiRuntimeSession;
  callerSessionId: string;
  targetBusy: boolean;
  shared: boolean;
}): ReturnDeliveryMembership {
  if (!shared) return { owner: true, accept() {}, release() {} };

  const groups = (target.returnDeliveryGroups ??= new Map());
  const current = groups.get(callerSessionId);
  const joinsCurrentRun = current !== undefined && (current.phase === "starting" || targetBusy);
  const group: ReturnDeliveryGroup = joinsCurrentRun ? current : { phase: "starting", participants: 0 };

  if (!joinsCurrentRun) groups.set(callerSessionId, group);
  group.participants += 1;
  let released = false;
  return {
    owner: !joinsCurrentRun,
    accept() {
      if (groups.get(callerSessionId) === group) group.phase = "running";
    },
    release() {
      if (released) return;
      released = true;
      group.participants -= 1;
      if (group.participants === 0 && groups.get(callerSessionId) === group) groups.delete(callerSessionId);
    },
  };
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

export async function awaitTargetCompletion(
  target: PiRuntimeSession,
  parentDelegationId: DelegationId,
  runtime: ExtensionRuntime,
  signal?: AbortSignal,
) {
  const sessionId = target.session.sessionManager.getSessionId();
  let current = target;

  while ((await runtime.runPromise(awaitJoinedDelegations(parentDelegationId), { signal })) > 0) {
    current = getRuntimeSession(sessionId) ?? target;
    await waitForSessionTurnEnd(current.session, runtime, signal);
  }

  return current;
}

export function waitForSessionTurnEnd(session: SessionController, runtime: ExtensionRuntime, signal?: AbortSignal) {
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

export function startsAgentTurn(command: UnknownRecord) {
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

export function customDeliveryOptions(
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
  return recoverDiagnostic(
    "extension-context-liveness",
    () => {
      void ctx.cwd;
      return !callerSessionId || ctx.sessionManager.getSessionId() === callerSessionId;
    },
    () => false,
  );
}

export function delegationReceipt(callerAgent: unknown, callerSessionId: unknown, message: string) {
  const agent = callerAgent ? `[${callerAgent}] agent` : "agent";
  return `Message from ${agent} from session ${String(callerSessionId ?? "")}:\n${message}\nComplete the task before answering. Only your final result will be returned.`;
}

export function delegationReturn(agentName: unknown, sessionId: unknown, finalAnswer: string) {
  const agent = agentName ? `[${agentName}] agent` : "agent";
  return `Message from ${agent} from session ${String(sessionId ?? "")}:\n${finalAnswer}`;
}
