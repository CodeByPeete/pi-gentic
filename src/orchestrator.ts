/**
 * Orchestration facade for Pi.
 *
 * The orchestrator coordinates policy, prompts, runtime sessions, and run
 * delivery while keeping Pi-specific APIs behind this single class.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  buildReceiptText,
  buildReturnText,
  chooseBoolean,
  getErrorMessage,
  parseIntegerRadius,
  shortSessionId,
} from "./core.js";
import { loadAvailableSkills, loadConfiguration } from "./config.js";
import {
  activeAgentName,
  appendActiveState,
  assertAvailableAgent,
  configuredDefaultAgent,
  filterAvailableAgents,
  getActiveState,
  nextAgentName,
  resolveSessionPolicy,
  shouldApplyDefaultAgent,
} from "./policy.js";
import {
  buildResolvedSystemPrompt,
  mergeSkillEntries,
  parseSkillEntries,
} from "./prompt.js";
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
} from "./runtime.js";
import {
  abortActor,
  collectSessionActivities,
  createSessionActivityMonitor,
  deliverReturnToCaller,
  deliverSendContextToCaller,
  displayTargetAnswerIfVisible,
  mergeActivities,
  resolveReturnDelivery,
  sendPendingText,
  sendStatusText,
  sessionRunOutcome,
  sessionStatus,
} from "./runs.js";
import {
  assertDifferentSession,
  assignTreeDepths,
  buildSessionTree,
  cachedPersistedSessions,
  currentSessionSummary,
  enrichSessionSummaries,
  listSessionSummariesFast,
  resolveSessionReference,
  sessionDiscoveryScope,
  withRuntimeState,
} from "./sessions.js";
import { setAgentLabel, setLiveCardDetails } from "./ui.js";
import { prepareWorktree } from "./worktrees.js";

type CallerMessageDelivery = {
  callerSessionId?: string;
  callerSessionManager: PiSessionManager;
  callerCwd?: string;
  config: AnyRecord;
  text: string;
  invoke: boolean;
  queue?: string;
};

/** Main application service used by commands, shortcuts, events, and tools. */
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

  /** Applies the current session policy to Pi tools, model, thinking, theme, and labels. */
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

  /** Stores a handoff in session history, then re-applies the resolved policy. */
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

  /** Sends one message to a child or existing session and tracks the resulting run. */
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
        !targetBusy && typeof target.session.subscribe === "function"
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
            ? { streamingBehavior: "followUp" }
            : undefined,
        );
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

    const session = await this.createChildSession(ctx, input);

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

  async createChildSession(
    ctx: PiContext,
    input: AnyRecord,
  ): Promise<PiRuntimeSession> {
    let sessionManager;
    const sessionDir = ctx.sessionManager.getSessionDir();
    persistSessionImmediately(ctx.sessionManager);
    const parentSession = ctx.sessionManager.getSessionFile();

    if (input.fork && parentSession) {
      sessionManager = SessionManager.forkFrom(
        parentSession,
        input.cwd ?? ctx.cwd,
        sessionDir,
      );
    } else {
      sessionManager = SessionManager.create(input.cwd ?? ctx.cwd, sessionDir, {
        parentSession,
      });
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
    const existing = findRuntimeSession((runtime) =>
      matchesSession(runtime.session.sessionManager.getSessionId(), reference),
    );

    if (existing) return existing;
    const sessions = await SessionManager.list(
      cwd ?? ctx.cwd,
      ctx.sessionManager.getSessionDir(),
    );
    const resolved = resolveSessionReference(sessions, reference);
    const sessionManager = SessionManager.open(
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

  /** Builds the orchestration tree visible to the agents tool and TUI picker. */
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

  return fast.length > 0 ? fast : SessionManager.list(cwd, sessionDir);
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
