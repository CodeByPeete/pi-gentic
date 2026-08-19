import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentOperations } from "../agents/activation.js";
import {
  appendActiveState,
  assertCanCreateSubagent,
  getActiveState,
  isThinkingLevel,
  subagentCreationError,
} from "../agents/activation.js";
import { abortActor } from "../delegation/delivery.js";
import { sessionStatus } from "../delegation/activity.js";
import {
  applyInheritedModel,
  createLiveRuntime,
  listRuntimeSessions,
  persistSessionImmediately,
  resolveModelFromCatalog,
  setRuntimeSession,
} from "../pi/sessions.js";
import type { PiAgentRuntimeHost, PiAgentSession, PiContext, PiRuntimeSession, PiSessionManager } from "../pi/types.js";
import { loadConfiguration } from "../settings.js";
import type { UnknownRecord } from "../shared/values.js";
import { isRecord, nonNegativeInteger as parseIntegerRadius, shortSessionId } from "../shared/values.js";
import { resolveSessionPolicy } from "./policy.js";
import {
  assertSessionMessagingScope,
  enrichSessionSummaries,
  sessionDiscoveryScope,
  assignTreeDepths,
  buildSessionTree,
  currentSessionSummary,
  resolveRootedSessionDepth,
  resolveSessionReference,
  runtimeSessionSummary,
  withRuntimeState,
} from "./catalog.js";

type Configuration = ReturnType<typeof loadConfiguration>;

export interface SendInput extends UnknownRecord {
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

function registerRuntimeHost(runtimeHost: PiAgentRuntimeHost, metadata: UnknownRecord = {}) {
  const session = runtimeHost.session;
  const sessionManager = session.sessionManager;
  const runtime: PiRuntimeSession = {
    runtimeHost,
    session,
    agentName: getActiveState(sessionManager).agentName,
    lastMessage: "",
    createdAt: new Date().toISOString(),
    ...metadata,
  };
  setRuntimeSession(sessionManager.getSessionId(), runtime);
  return runtime;
}

async function listDiscoverySessionSources(cwd: string, sessionDir?: string) {
  const sessions = await SessionManager.list(cwd, sessionDir);
  return sessions.flatMap((session) => (isRecord(session) ? [session] : []));
}

function matchesSession(sessionId: unknown, reference: unknown) {
  const id = String(sessionId).toLowerCase();
  const query = String(reference).toLowerCase();
  return id === query || id.startsWith(query) || id.includes(query) || shortSessionId(id) === query;
}

export function createSessionOperations(agents: AgentOperations) {
  const { reconcileSessionTools } = agents;
  const sessionDepths = new WeakMap<PiSessionManager, number>();

  async function canCreateChildSession(ctx: PiContext, config: Configuration = agents.load(ctx)) {
    return !subagentCreationError(await subagentCreationLimits(ctx, config));
  }

  async function assertCanCreateChildSession(ctx: PiContext, config: Configuration) {
    assertCanCreateSubagent(await subagentCreationLimits(ctx, config));
  }

  async function subagentCreationLimits(ctx: PiContext, config: Configuration) {
    const policy = agents.resolvePolicy(ctx, config);
    const limits = {
      currentDepth: 0,
      maxSubagentDepth: policy.maxSubagentDepth,
      globalMaxSubagentDepth: config.settings.globalMaxSubagentDepth,
    };

    if (!subagentCreationError(limits)) limits.currentDepth = await cachedSessionDepth(ctx);
    return limits;
  }

  async function cachedSessionDepth(ctx: PiContext) {
    const cached = sessionDepths.get(ctx.sessionManager);
    if (cached !== undefined) return cached;

    const depth = resolveRootedSessionDepth(
      currentSessionSummary(ctx),
      await listDiscoverySessionSources(ctx.cwd, ctx.sessionManager.getSessionDir()),
      listRuntimeSessions(),
    );
    sessionDepths.set(ctx.sessionManager, depth);
    return depth;
  }

  async function assertCanMessageSession(ctx: PiContext, target: PiRuntimeSession, config: Configuration) {
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

  async function createChildSession(
    ctx: PiContext,
    input: SendInput,
    config: Configuration = agents.load(ctx),
    options: { call?: UnknownRecord } = {},
  ): Promise<PiRuntimeSession> {
    let sessionManager;
    const sessionDir = ctx.sessionManager.getSessionDir();
    persistSessionImmediately(ctx.sessionManager);
    await operations.assertCanCreateChildSession(ctx, config);
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

  async function getOrOpenSession(ctx: PiContext, reference: unknown, cwd?: string): Promise<PiRuntimeSession> {
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

  async function loadAgentIntoSession(
    session: PiAgentSession,
    agentName: string,
    overrides: unknown,
    config: Configuration,
    accessContext?: PiContext,
  ) {
    const agent = accessContext
      ? agents.assertAgentAvailable(accessContext, agentName, config)
      : config.agents.find((item) => item.name.toLowerCase() === agentName.toLowerCase());

    if (!agent) throw new Error(`Unknown agent "${agentName}".`);
    appendActiveState(session.sessionManager, {
      agentName: agent.name,
      overrides,
    });
    await operations.applyPolicyToAgentSession(session, config);
    setRuntimeSession(session.sessionManager.getSessionId(), {
      session,
      agentName: agent.name,
    });
  }

  async function applySessionOverrides(session: PiAgentSession, overrides: unknown, config: Configuration) {
    const state = getActiveState(session.sessionManager);

    appendActiveState(session.sessionManager, {
      agentName: state.agentName,
      overrides,
    });

    return operations.applyPolicyToAgentSession(session, config);
  }

  async function applyPolicyToAgentSession(session: PiAgentSession, config: Configuration) {
    const resolvedPolicy = operations.resolveAgentSessionPolicy(session, config);

    if (resolvedPolicy.model) {
      const model = resolveModelFromCatalog(session.modelRuntime, resolvedPolicy.model);

      if (model) await session.setModel(model);
    }

    if (isThinkingLevel(resolvedPolicy.thinking)) session.setThinkingLevel(resolvedPolicy.thinking);
    const tools = reconcileSessionTools(
      session.sessionManager,
      session.getAllTools().map((tool) => tool.name),
      session.getActiveToolNames(),
      resolvedPolicy.toolFilters,
      (selection) => session.setActiveToolsByName(selection),
    );

    return { ...resolvedPolicy, resources: { ...resolvedPolicy.resources, tools } };
  }

  async function applyAgentlessPolicyToNewSession(
    session: PiAgentSession,
    config: Configuration,
    inheritedModel: NonNullable<PiContext["model"]> | undefined,
  ) {
    const policy = await operations.applyPolicyToAgentSession(session, config);
    await applyInheritedModel(session, policy, inheritedModel);

    return policy;
  }

  function resolveAgentSessionPolicy(session: PiAgentSession, config: Configuration) {
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

  async function status(ctx: PiContext, sessionId: unknown) {
    if (!sessionId) throw new Error('Field "sessionId" is required for status.');
    const runtime = await operations.getOrOpenSession(ctx, sessionId);

    return sessionStatus(runtime);
  }

  async function abort(ctx: PiContext, sessionId: unknown) {
    if (!sessionId) {
      ctx.abort();

      return `Aborted session ${shortSessionId(ctx.sessionManager.getSessionId())}.`;
    }

    const runtime = await operations.getOrOpenSession(ctx, sessionId);
    runtime.lastAbort = { actor: abortActor(ctx), at: Date.now() };
    await runtime.session.abort();

    return `Aborted session ${shortSessionId(runtime.session.sessionManager.getSessionId())}.`;
  }

  async function runtimeForCallerInvocation({
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
      : operations.createRuntimeForSessionManager(callerSessionManager, callerCwd);
  }

  async function createRuntimeForSessionManager(
    sessionManager: PiSessionManager,
    cwd?: string,
  ): Promise<PiRuntimeSession> {
    persistSessionImmediately(sessionManager);
    const runtimeHost = await createLiveRuntime({
      cwd: cwd ?? sessionManager.getCwd(),
      sessionManager,
    });

    return registerRuntimeHost(runtimeHost, {
      createdAt: new Date().toISOString(),
    });
  }

  async function discoverSessions(ctx: PiContext, input: { rx?: number; ry?: number; all?: boolean }) {
    const policy = agents.resolvePolicy(ctx, agents.load(ctx));
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

  function resolveModel(ctx: PiContext, modelName: string) {
    return resolveModelFromCatalog(ctx.modelRegistry, modelName);
  }

  const operations = {
    canCreateChildSession,
    assertCanCreateChildSession,
    assertCanMessageSession,
    createChildSession,
    getOrOpenSession,
    loadAgentIntoSession,
    applySessionOverrides,
    applyPolicyToAgentSession,
    applyAgentlessPolicyToNewSession,
    resolveAgentSessionPolicy,
    status,
    abort,
    runtimeForCallerInvocation,
    createRuntimeForSessionManager,
    discoverSessions,
    resolveModel,
  };
  return operations;
}
