import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { createAgentOperations, getActiveState, type AgentOperations } from "../agents/activation.js";
import { loadConfiguration } from "../settings.js";
import {
  booleanOr as chooseBoolean,
  cardDetails,
  errorMessage as getErrorMessage,
  isRecord,
  shortSessionId,
} from "../shared/values.js";
import { reportRuntimeDiagnostic } from "../shared/diagnostics.js";
import {
  DelegationFibers,
  abortAgentCall,
  assertNoAgentCallCycle,
  createDelegationId,
  registerAgentCall,
} from "./runs.js";
import {
  activeVisibleContext,
  activeVisibleExtension,
  activeVisibleSession,
  findRuntimeSession,
  persistSessionImmediately,
  pruneRuntimeSessions,
  setRuntimeSession,
  unregisterLiveRuntime,
} from "../pi/sessions.js";
import { assertDifferentSession } from "../sessions/catalog.js";
import { createSessionOperations, type SendInput } from "../sessions/manage.js";
import { prepareWorktreeEffect, type ExtensionRuntime } from "../extension-runtime.js";
import type { PiAgentSession, PiApi, PiContext, PiRuntimeSession, PiSessionManager } from "../pi/types.js";
import type { UnknownRecord } from "../shared/values.js";
import { CARD_MESSAGE_TYPE, setLiveCardDetails } from "../ui/cards.js";
import {
  AgentCallFailed,
  delegationReceipt as buildReceiptText,
  delegationReturn as buildReturnText,
  deliverCardToCaller,
  deliverSendContextToCaller,
  awaitTargetCompletion,
  customDeliveryOptions,
  joinReturnDeliveryGroup,
  persistAgentCardState,
  prepareTargetPromptForSend,
  promptSessionAndWaitForTurnEnd,
  resolveReturnDelivery,
  resolveTargetSlashCommand,
  sendPendingText,
  sendStatusText,
  slashCommandDeliveryText,
  startsAgentTurn,
  waitForSessionTurnEnd,
  type DeliveryQueue,
} from "./delivery.js";
import {
  completeSessionActivities,
  createSessionActivityMonitor,
  recordRunResult,
  sessionRunOutcome,
} from "./activity.js";
type Configuration = ReturnType<typeof loadConfiguration>;
interface SendCallbacks extends UnknownRecord {
  awaitCompletion?: boolean;
  onRefresh?: (details: UnknownRecord) => void;
  onUpdate?: AgentToolUpdateCallback<unknown>;
  signal?: AbortSignal;
  call?: UnknownRecord;
  onSettled?: () => void;
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

export function createOrchestrator(
  pi: PiApi,
  runtime: ExtensionRuntime,
  setAgentLabel: (ctx: PiContext, agentName: unknown) => void = () => {},
) {
  const agentOperations = createAgentOperations(pi, setAgentLabel);
  const sessionOperations = createSessionOperations(agentOperations);
  type Dispatch = AgentOperations &
    typeof sessionOperations & {
      send: typeof send;
      resolveSendCwd: typeof resolveSendCwd;
      prepareWorktree: typeof prepareWorktree;
      applyRequestedTargetPolicy: typeof applyRequestedTargetPolicy;
      resolveTargetSession: typeof resolveTargetSession;
      deliverCallerCard: typeof deliverCallerCard;
      invokeCallerSession: typeof invokeCallerSession;
      cardDetails: typeof cardDetails;
    };
  let orchestrator: Dispatch;

  async function send(ctx: PiContext, input: SendInput, callbacks: SendCallbacks = {}) {
    const config = orchestrator.load(ctx);

    if (input.agent) orchestrator.assertAgentAvailable(ctx, input.agent, config);
    const callerState = getActiveState(ctx.sessionManager);
    const callerAgent = callerState.agentName;
    const callerActor = callerAgent ? `[${callerAgent}] agent` : "caller session";
    const defaults = orchestrator.resolvePolicy(ctx, config, callerState).agentsTool;
    const invokeDefaults = isRecord(defaults.invokeMeLater) ? defaults.invokeMeLater : {};
    const targetAsync = input.sessionId ? true : chooseBoolean(input.async, chooseBoolean(defaults.async, false));
    const targetFork = chooseBoolean(input.fork, chooseBoolean(defaults.fork, false));
    const cwd = await resolveSendCwd(ctx, {
      ...input,
      cwd: input.cwd ?? (typeof defaults.cwd === "string" ? defaults.cwd : undefined),
    });
    const invokeMeLater = chooseBoolean(
      input.invokeMeLater,
      targetAsync ? invokeDefaults.async !== false : invokeDefaults.withSession !== false,
    );
    const startedAt = Date.now();
    const delegationId = createDelegationId();
    const returnDelivery = resolveReturnDelivery({
      async: targetAsync,
      awaitCompletion: callbacks.awaitCompletion,
    });
    const target = await orchestrator.resolveTargetSession(
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
    const targetCommand = resolveTargetSlashCommand(input.message, target.session);
    const returnDeliveryMembership = joinReturnDeliveryGroup({
      target,
      callerSessionId,
      targetBusy,
      shared: returnDelivery.kind === "callerMessage" && (!targetCommand || startsAgentTurn(targetCommand)),
    });
    let requestAccepted = false;
    const acceptRequest = () => {
      if (requestAccepted) return;
      requestAccepted = true;
      returnDeliveryMembership.accept();
    };
    const shouldPresentOutcome = () => returnDeliveryMembership.owner || !requestAccepted;
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
    const details = cardDetails("send", targetBusy ? "queued" : "running", {
      cardId: delegationId,
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
      cardDetails("delegation", "done", {
        callerSessionId,
        callerSessionPath: callerSessionManager.getSessionFile(),
        sessionId: targetSessionId,
        ...(call ? { call } : {}),
      }),
    );
    persistSessionImmediately(target.session.sessionManager);
    let terminalStatePersisted = false;
    const publish = (nextDetails: UnknownRecord, options: UnknownRecord = {}) => {
      const liveDetails = setLiveCardDetails(nextDetails, { runtime: runtime }) ?? nextDetails;

      if (!terminalStatePersisted && returnDelivery.kind === "callerMessage" && shouldPresentOutcome())
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
    const deliverOutcome = async (text: string, outcomeDetails: UnknownRecord, invoke = invokeMeLater) => {
      if (returnDelivery.kind !== "callerMessage" || !shouldPresentOutcome()) return;
      return orchestrator.deliverCallerCard(ctx, {
        callerSessionId,
        callerSessionManager,
        callerCwd,
        config,
        text,
        details: outcomeDetails,
        invoke,
        queue: returnDelivery.queue,
      });
    };
    deliverSendContextToCaller({
      pi: pi,
      ctx,
      target,
      message: input.message,
      async: targetAsync,
      fork: targetFork,
    });
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
      completionMode: returnDelivery.kind === "callerMessage" && invokeMeLater ? "joined" : "detached",
      isCancellable: () => target.session.isStreaming === true,
      abort: async (options: UnknownRecord = {}) => {
        await abortTarget(options);
        await runtime.runPromise(Effect.flatMap(DelegationFibers, (fibers) => fibers.abort(delegationId)));
      },
    });
    const runAbort = (scope: string, operation: () => Promise<unknown>) => {
      try {
        runtime.runFork(
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
      const releaseRuntime = runtime.retain();
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
        const promptOptions: NonNullable<Parameters<PiAgentSession["prompt"]>[1]> = {
          ...(target.session.isStreaming ? { streamingBehavior: "steer" } : {}),
          preflightResult: (accepted) => {
            if (accepted) acceptRequest();
          },
        };
        await promptSessionAndWaitForTurnEnd(
          target.session,
          runtime,
          () => target.session.prompt(targetPrompt.text, promptOptions),
          callbacks.signal,
        );
        acceptRequest();
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
        if (targetBusy) await waitForSessionTurnEnd(target.session, runtime, callbacks.signal);
        const completedTarget = await awaitTargetCompletion(target, delegationId, runtime, callbacks.signal);
        const outcome = sessionRunOutcome(completedTarget, { request: input.message });
        const completed = recordRunResult(
          completedTarget,
          outcome.status === "done"
            ? monitor.finish({
                answer: outcome.text,
                activities: completeSessionActivities(completedTarget.session),
              })
            : monitor.stop(outcome.status, {
                error: outcome.text,
                activities: completeSessionActivities(completedTarget.session),
              }),
        );
        const returnText =
          outcome.status === "done" ? buildReturnText(target.agentName, targetSessionId, outcome.text) : outcome.text;
        await deliverOutcome(returnText, completed);
        return {
          answer: returnDelivery.kind === "callerMessage" ? outcome.text : returnText,
          details: completed,
        };
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
        await deliverOutcome(outcome.text, failed);
        return { answer: outcome.text, details: failed };
      } finally {
        try {
          unsubscribe?.();
          setRuntimeSession(targetSessionId, target);
          callbacks.signal?.removeEventListener?.("abort", abortFromSignal);
          operationSignal?.removeEventListener("abort", abortFromOperation);
          activeCall.unregister();
          returnDeliveryMembership.release();

          if (target.session.isStreaming !== true) unregisterLiveRuntime(targetSessionId);
          pruneRuntimeSessions();
        } finally {
          releaseRuntime();
        }
      }
    };

    if (returnDelivery.kind === "callerMessage") {
      const operation = Effect.tryPromise({
        try: async (signal) => {
          await run(signal);
        },
        catch: getErrorMessage,
      }).pipe(
        Effect.catch((message) =>
          Effect.tryPromise({
            try: () =>
              deliverOutcome(
                message,
                cardDetails("send", "error", {
                  ...details,
                  status: "error",
                  error: message,
                  completedAt: Date.now(),
                  updatedAt: Date.now(),
                }),
                false,
              ),
            catch: getErrorMessage,
          }).pipe(Effect.ignore),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            callbacks.onSettled?.();
          }),
        ),
      );

      await runtime.runPromise(Effect.flatMap(DelegationFibers, (fibers) => fibers.run(delegationId, operation)));

      return {
        text: sendPendingText({
          async: targetAsync,
          agentName: target.agentName,
          sessionId: target.session.sessionManager.getSessionId(),
          message: input.message,
          details,
        }),
        details: cardDetails("send", details.status ?? "running", details),
      };
    }

    const result = await run();
    callbacks.onSettled?.();

    return { text: result.answer, details: result.details };
  }

  async function resolveSendCwd(ctx: PiContext, input: SendInput) {
    if (input.worktree === undefined) return input.cwd ?? ctx.cwd;

    return orchestrator.prepareWorktree(ctx, input);
  }

  async function prepareWorktree(ctx: PiContext, input: SendInput) {
    const automaticSource = input.worktree === true && input.repo === undefined ? input.cwd : undefined;

    return runtime.runPromise(
      prepareWorktreeEffect({
        ...input,
        repoCwd: ctx.cwd,
        ...(automaticSource === undefined ? {} : { repo: automaticSource, cwd: undefined }),
        worktree: input.worktree === true ? "" : input.worktree,
      }),
    );
  }

  async function applyRequestedTargetPolicy(session: PiAgentSession, input: SendInput, config: Configuration) {
    if (input.agent) return orchestrator.loadAgentIntoSession(session, input.agent, input.overrides, config);

    if (input.overrides) return orchestrator.applySessionOverrides(session, input.overrides, config);
  }

  async function resolveTargetSession(
    ctx: PiContext,
    input: SendInput,
    config: Configuration,
    options: { call?: UnknownRecord } = {},
  ): Promise<PiRuntimeSession> {
    if (input.sessionId) {
      const session = await orchestrator.getOrOpenSession(ctx, input.sessionId, input.cwd);
      const callerSessionId = ctx.sessionManager.getSessionId();
      const targetSessionId = session.session.sessionManager.getSessionId();

      assertDifferentSession(callerSessionId, targetSessionId);
      assertNoAgentCallCycle(callerSessionId, targetSessionId);
      await orchestrator.assertCanMessageSession(ctx, session, config);

      await orchestrator.applyRequestedTargetPolicy(session.session, input, config);

      return session;
    }

    const session = await orchestrator.createChildSession(ctx, input, config, options);

    await orchestrator.applyRequestedTargetPolicy(session.session, input, config);

    if (!input.agent && !input.overrides)
      await orchestrator.applyAgentlessPolicyToNewSession(session.session, config, ctx.model);

    if (typeof input.agent === "string") session.agentName = input.agent;

    return session;
  }

  async function deliverCallerCard(
    ctx: PiContext,
    { callerSessionId, callerSessionManager, callerCwd, config, text, details, invoke, queue }: CallerCardParameters,
  ) {
    return deliverCardToCaller({
      pi: activeVisibleExtension() ?? pi,
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
        orchestrator.invokeCallerSession({
          callerSessionManager,
          callerCwd,
          message,
          config,
          queue,
        }),
    });
  }

  async function invokeCallerSession({
    callerSessionManager,
    callerCwd,
    message,
    config,
    queue = "steer",
  }: CallerInvocationParameters) {
    const sessionId = callerSessionManager.getSessionId();
    const existing = findRuntimeSession((runtime) => runtime.session.sessionManager.getSessionId() === sessionId);
    const runtime = await orchestrator.runtimeForCallerInvocation({
      existing,
      callerSessionManager,
      callerCwd,
    });

    await orchestrator.applyPolicyToAgentSession(runtime.session, config);
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

  const composed = Object.assign(agentOperations, sessionOperations, {
    send,
    resolveSendCwd,
    prepareWorktree,
    applyRequestedTargetPolicy,
    resolveTargetSession,
    deliverCallerCard,
    invokeCallerSession,
    cardDetails,
  });
  orchestrator = new Proxy(composed, {
    set(target, property, value) {
      if (property in sessionOperations) Reflect.set(sessionOperations, property, value);
      return Reflect.set(target, property, value);
    },
  });
  return orchestrator;
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
