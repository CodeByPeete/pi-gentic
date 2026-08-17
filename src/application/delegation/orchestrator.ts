import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { Effect, Schema } from "effect";
import {
  activeAgentName,
  appendActiveState,
  assertAvailableAgent,
  assertCanCreateSubagent,
  configuredDefaultAgent,
  filterAvailableAgents,
  getActiveState,
  nextAgentName,
  shouldApplyDefaultAgent,
} from "../agents/state.js";
import { buildResolvedSystemPrompt } from "../agents/prompt.js";
import { delegationReceipt as buildReceiptText, delegationReturn as buildReturnText } from "./messages.js";
import { resolveSessionPolicy } from "../../domain/session-policy.js";
import type { AgentDefinition } from "../../domain/configuration.js";
import { loadConfiguration } from "../../infrastructure/configuration/agents.js";
import { loadAvailableSkills, systemPromptSkillEntries } from "../../infrastructure/configuration/skills.js";
import {
  booleanOr as chooseBoolean,
  errorMessage as getErrorMessage,
  isRecord,
  nonNegativeInteger as parseIntegerRadius,
  shortSessionId,
} from "../../shared/value.js";
import { recoverDiagnostic, reportRuntimeDiagnostic } from "../../shared/diagnostics.js";
import { AgentName, SessionId } from "../../domain/identifiers.js";
import { reconcileActiveToolSelection, type ToolPolicyState } from "../../domain/capabilities.js";
import { DelegationFibers } from "../../infrastructure/runtime/DelegationFibers.js";
import { createDelegationId } from "../../infrastructure/runtime/DelegationRegistry.js";
import { RuntimeMetadata, RuntimeRegistry } from "../../infrastructure/runtime/RuntimeRegistry.js";
import {
  abortAgentCall,
  assertNoAgentCallCycle,
  activeVisibleContext,
  activeVisibleExtension,
  activeVisibleSession,
  applyInheritedModel,
  createLiveRuntime,
  findRuntimeSession,
  listRuntimeSessions,
  persistSessionImmediately,
  pruneRuntimeSessions,
  registerAgentCall,
  resolveModelFromCatalog,
  setRuntimeSession,
  unregisterLiveRuntime,
} from "../../infrastructure/pi/host.js";
import {
  assertDifferentSession,
  assertSessionMessagingScope,
  enrichSessionSummaries,
  resolveSessionReference,
  sessionDiscoveryScope,
} from "../sessions/model.js";
import {
  assignTreeDepths,
  buildSessionTree,
  currentSessionSummary,
  resolveCurrentSessionDepth,
  runtimeSessionSummary,
  withRuntimeState,
} from "../sessions/runtime-view.js";
import { prepareWorktreeEffect, type ExtensionRuntime } from "../../runtime/ExtensionRuntime.js";
import { AgentCallFailed } from "../../domain/errors.js";
import type {
  PiAgentRuntimeHost,
  PiAgentSession,
  PiApi,
  PiContext,
  PiRuntimeSession,
  PiSessionManager,
} from "../../infrastructure/pi/types.js";
import type { UnknownRecord } from "../../shared/types.js";
import { setAgentLabel } from "../../interface/cards/live.js";
import { CARD_MESSAGE_TYPE, setLiveCardDetails } from "../../interface/cards/state.js";
import {
  abortActor,
  deliverCardToCaller,
  deliverSendContextToCaller,
  awaitTargetCompletion,
  customDeliveryOptions,
  isStaleExtensionContextError,
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
} from "./delivery.js";
import {
  completeSessionActivities,
  createSessionActivityMonitor,
  recordRunResult,
  sessionRunOutcome,
  sessionStatus,
} from "./activity.js";
import type {
  CallerCardParameters,
  CallerInvocationParameters,
  Configuration,
  SendCallbacks,
  SendInput,
  SessionPolicy,
} from "./contracts.js";

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
      skills: availableSkillNames(ctx),
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

  private resolveCurrentPolicy(ctx: PiContext, resources: { tools?: string[]; skills?: string[] } = {}) {
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
      const { config, policy, activeAgent } = this.applyPolicySnapshot(ctx, {
        skills: availableSkillNames(ctx),
      });

      return {
        systemPrompt: buildResolvedSystemPrompt({
          baseSystemPrompt: event.systemPrompt,
          config: { ...config, activeAgent },
          policy,
        }),
      };
    } catch (error) {
      if (isStaleExtensionContextError(error)) return undefined;
      throw error;
    }
  }

  applyPolicySnapshot(ctx: PiContext, resources: { skills?: string[] } = {}) {
    const snapshot = this.resolveCurrentPolicy(ctx, {
      tools: this.pi.getActiveTools(),
      skills: resources.skills ?? availableSkillNames(ctx),
    });
    this.currentAgentName = snapshot.policy.agentName;
    return snapshot;
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
    const clearing = !agentName || agentName === "clear";
    const agent = clearing
      ? undefined
      : options.enforceAccess === false
        ? config.agents.find((item) => item.name.toLowerCase() === String(agentName).toLowerCase())
        : this.assertAgentAvailable(ctx, agentName, config);

    if (!clearing && !agent)
      throw new Error(
        `Unknown agent "${agentName}". Available agents: ${config.agents.map((item) => item.name).join(", ") || "none"}.`,
      );
    appendActiveState(ctx.sessionManager, {
      agentName: agent?.name,
      overrides: agent ? options.overrides : undefined,
    });
    const { policy } = await this.applyCurrentPolicy(ctx);
    const sessionId = ctx.sessionManager.getSessionId();

    return {
      text: agent ? `Loaded ${agent.name} agent in session ${shortSessionId(sessionId)}.` : "Cleared active agent.",
      details: this.cardDetails("load", "done", {
        agentName: agent?.name ?? "agentless",
        sessionId,
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
    const delegationId = createDelegationId();
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
      return this.deliverCallerCard(ctx, {
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
      pi: this.pi,
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
      const releaseRuntime = this.runtime.retain();
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
          this.runtime,
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
        if (targetBusy) await waitForSessionTurnEnd(target.session, this.runtime, callbacks.signal);
        const completedTarget = await awaitTargetCompletion(target, delegationId, this.runtime, callbacks.signal);
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
                this.cardDetails("send", "error", {
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
    const runtimeHost = await createLiveRuntime({ cwd: input.cwd ?? ctx.cwd, sessionManager });
    return registerRuntimeHost(runtimeHost, {
      parentSessionId,
      parentSessionPath: parentSession,
      lastMessage: input.message,
      createdAt: new Date().toISOString(),
    });
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
  return recoverDiagnostic(
    "current-skill-names",
    () => ctx.getSystemPromptOptions?.().skills?.map((skill) => skill.name) ?? [],
    () => [],
  );
}

function availableSkillNames(ctx: PiContext) {
  const skills = [
    ...systemPromptSkillEntries(ctx),
    ...loadAvailableSkills({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted?.() === true,
    }),
  ];
  const names = skills.flatMap((skill) => (typeof skill.name === "string" ? [skill.name] : []));

  return names.length > 0 ? [...new Set(names)] : currentSkillNames(ctx);
}

function safeSystemPrompt(ctx: PiContext) {
  return recoverDiagnostic(
    "current-system-prompt",
    () => ctx.getSystemPrompt?.() ?? "",
    () => "",
  );
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
