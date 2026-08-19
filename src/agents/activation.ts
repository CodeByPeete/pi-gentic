import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { Exit, Schema } from "effect";
import { resolveModelFromCatalog } from "../pi/sessions.js";
import type { PiApi, PiContext, PiSessionManager } from "../pi/types.js";
import { loadConfiguration, type AgentDefinition } from "../settings.js";
import { isStaleExtensionContextError, recoverDiagnostic } from "../shared/diagnostics.js";
import type { UnknownRecord } from "../shared/values.js";
import { cardDetails, isRecord, shortSessionId } from "../shared/values.js";
import { resolveSessionPolicy, reconcileActiveToolSelection, type ToolPolicyState } from "../sessions/policy.js";
import { buildResolvedSystemPrompt } from "./prompts.js";
import { loadAvailableSkills, systemPromptSkillEntries } from "./skills.js";

type Configuration = ReturnType<typeof loadConfiguration>;
type SessionPolicy = ReturnType<typeof resolveSessionPolicy>;

const persistedStateDiagnostics = new Set<string>();

const ActiveStateSchema = Schema.Struct({
  agentName: Schema.optional(Schema.String.check(Schema.isPattern(/\S/))),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
});

export function getActiveState(sessionManager: PiSessionManager) {
  const entries = sessionManager.getEntries?.() ?? [];

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];

    if (isRecord(entry) && entry.type === "custom" && entry.customType === "pi-gentic:state") {
      const decoded = decodeActiveState(entry.data);

      if (decoded) return decoded;
      persistedStateDiagnostics.add("Ignored an invalid persisted active-agent state.");
    }
  }

  return emptyActiveState();
}

export function appendActiveState(sessionManager: PiSessionManager, state: unknown) {
  if (typeof sessionManager.appendCustomEntry !== "function")
    throw new Error("The active Pi session does not support custom state entries.");

  sessionManager.appendCustomEntry("pi-gentic:state", decodeActiveState(state) ?? {});
}

function decodeActiveState(value: unknown) {
  const decoded = Schema.decodeUnknownExit(ActiveStateSchema)(value);

  return Exit.isSuccess(decoded) ? decoded.value : undefined;
}

export function activeStateDiagnostics() {
  return [...persistedStateDiagnostics];
}

function emptyActiveState() {
  return { agentName: undefined, overrides: undefined };
}

export function subagentCreationError({
  currentDepth,
  maxSubagentDepth,
  globalMaxSubagentDepth,
}: {
  currentDepth: unknown;
  maxSubagentDepth: unknown;
  globalMaxSubagentDepth: unknown;
}) {
  const depth = Math.max(0, integer(currentDepth));
  const localLimit = integer(maxSubagentDepth);
  const globalLimit = integer(globalMaxSubagentDepth);
  const nextDepth = depth + 1;

  if (localLimit < 1)
    return new Error(
      `Cannot create a child session because maxSubagentDepth is ${localLimit}. Reuse an existing session or raise the local limit.`,
    );

  if (nextDepth > globalLimit)
    return new Error(
      `Cannot create a child session at depth ${nextDepth} because globalMaxSubagentDepth is ${globalLimit}. Reuse an existing session or raise the global limit.`,
    );

  return undefined;
}

export function assertCanCreateSubagent(limits: Parameters<typeof subagentCreationError>[0]) {
  const error = subagentCreationError(limits);
  if (error) throw error;
}

function integer(value: unknown) {
  const number = Number(value);

  return Number.isFinite(number) ? Math.floor(number) : 0;
}

export const AGENT_CYCLE_SHORTCUT = "f7";

export function nextAgentName(currentAgentName: string | undefined, agents: UnknownRecord[]) {
  const cycle = [undefined, ...agents.map((agent) => String(agent.name))];
  const index = cycle.findIndex((name) => name === currentAgentName);

  return cycle[index === -1 ? 1 : (index + 1) % cycle.length];
}

function hasPersistedAgentState(sessionManager: PiSessionManager) {
  return (sessionManager.getEntries?.() ?? []).some(
    (entry) => isRecord(entry) && entry.type === "custom" && entry.customType === "pi-gentic:state",
  );
}

export function shouldApplyDefaultAgent(event: { reason?: unknown }, sessionManager: PiSessionManager) {
  return (
    typeof event.reason === "string" &&
    ["new", "startup"].includes(event.reason) &&
    isBlankSession(sessionManager) &&
    !hasPersistedAgentState(sessionManager)
  );
}

function isBlankSession(sessionManager: PiSessionManager) {
  return !(sessionManager.getEntries?.() ?? []).some(
    (entry) => isRecord(entry) && (entry.type === "message" || entry.type === "custom_message"),
  );
}

export function configuredDefaultAgent(settings: UnknownRecord) {
  return typeof settings?.defaultAgent === "string" && settings.defaultAgent.trim()
    ? settings.defaultAgent.trim()
    : undefined;
}

function activeAgentName(sessionManager: PiSessionManager) {
  return getActiveState(sessionManager).agentName;
}

export function filterAvailableAgents(
  config: { agents: AgentDefinition[] },
  policy: { resources: { agents: string[] } },
) {
  const allowed = new Set(policy.resources.agents);

  return config.agents.filter((agent) => allowed.has(agent.name));
}

export function assertAvailableAgent(agentName: unknown, agents: AgentDefinition[]) {
  const agent = agents.find((item) => String(item.name).toLowerCase() === String(agentName ?? "").toLowerCase());

  if (!agent)
    throw new Error(
      `Unavailable agent "${agentName}". Available agents: ${agents.map((item) => item.name).join(", ") || "none"}.`,
    );

  return agent;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && ["minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

export function createAgentOperations(
  pi: PiApi,
  setAgentLabel: (ctx: PiContext, agentName: unknown) => void = () => {},
) {
  let currentAgentName: string | undefined;
  const toolPolicyStates = new WeakMap<PiSessionManager, ToolPolicyState>();

  function load(ctx: PiContext) {
    return loadConfiguration({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted?.() === true,
    });
  }

  function getActiveAgent(ctx: PiContext, config: Configuration = operations.load(ctx)) {
    const state = getActiveState(ctx.sessionManager);

    return config.agents.find((agent) => agent.name === state.agentName);
  }

  function resolvePolicy(
    ctx: PiContext,
    config: Configuration = operations.load(ctx),
    state = getActiveState(ctx.sessionManager),
    resources: { tools?: string[]; skills?: string[] } = {},
  ) {
    const activeAgent = config.agents.find((agent) => agent.name === state.agentName);

    return resolveSessionPolicy({
      settings: config.settings,
      activeAgent,
      overrides: state.overrides,
      allAgents: config.agents.map((agent) => agent.name),
      allTools: resources.tools ?? pi.getAllTools().map((tool) => tool.name),
      allSkills: resources.skills ?? currentSkillNames(ctx),
    });
  }

  function availableAgents(ctx: PiContext, config: Configuration = operations.load(ctx)) {
    return filterAvailableAgents(config, operations.resolvePolicy(ctx, config));
  }

  function assertAgentAvailable(ctx: PiContext, agentName: unknown, config: Configuration = operations.load(ctx)) {
    const configured = config.agents.find(
      (agent) => agent.name.toLowerCase() === String(agentName ?? "").toLowerCase(),
    );

    if (!configured)
      throw new Error(
        `Unknown agent "${agentName}". Available agents: ${config.agents.map((agent) => agent.name).join(", ") || "none"}.`,
      );

    return assertAvailableAgent(agentName, operations.availableAgents(ctx, config));
  }

  async function applyCurrentPolicy(ctx: PiContext, options: { running?: boolean } = {}) {
    const { config, policy: resolvedPolicy } = resolveCurrentPolicy(ctx, {
      skills: availableSkillNames(ctx),
    });

    if (resolvedPolicy.model) {
      const model = resolveModelFromCatalog(ctx.modelRegistry, resolvedPolicy.model);

      if (model) await pi.setModel(model);
    }

    if (isThinkingLevel(resolvedPolicy.thinking)) pi.setThinkingLevel(resolvedPolicy.thinking);

    if (resolvedPolicy.theme && ctx.mode === "tui") ctx.ui.setTheme(resolvedPolicy.theme);
    const policy = reconcileVisibleToolPolicy(ctx, resolvedPolicy);
    setTitle(ctx, options.running === true);
    setAgentWidget(ctx);

    return { config, policy };
  }

  function applyCurrentToolPolicy(ctx: PiContext, resources: { skills?: string[] } = {}) {
    const { config, policy: resolvedPolicy, activeAgent } = resolveCurrentPolicy(ctx, resources);
    const policy = reconcileVisibleToolPolicy(ctx, resolvedPolicy);

    return { config, policy, activeAgent };
  }

  function resolveCurrentPolicy(ctx: PiContext, resources: { tools?: string[]; skills?: string[] } = {}) {
    const config = operations.load(ctx);
    const state = getActiveState(ctx.sessionManager);
    const activeAgent = config.agents.find((agent) => agent.name === state.agentName);
    const policy = operations.resolvePolicy(ctx, config, state, resources);

    return { config, policy, activeAgent };
  }

  function reconcileVisibleToolPolicy(ctx: PiContext, policy: SessionPolicy) {
    const tools = reconcileSessionTools(
      ctx.sessionManager,
      pi.getAllTools().map((tool) => tool.name),
      pi.getActiveTools(),
      policy.toolFilters,
      (selection) => pi.setActiveTools(selection),
    );
    const effectivePolicy = { ...policy, resources: { ...policy.resources, tools } };

    currentAgentName = effectivePolicy.agentName;

    return effectivePolicy;
  }

  function reconcileSessionTools(
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
      previousState: toolPolicyStates.get(sessionManager),
    });

    if (reconciliation.changed) apply(reconciliation.selection);
    toolPolicyStates.set(sessionManager, reconciliation.state);

    return reconciliation.selection;
  }

  function setTitle(ctx: PiContext, running = false) {
    const agent = activeAgentName(ctx.sessionManager);

    if (agent) ctx.ui.setTitle(`${running ? "●" : "○"} ${agent}`);
  }

  function setAgentWidget(ctx: PiContext) {
    setAgentLabel(ctx, activeAgentName(ctx.sessionManager));
  }

  function prepareVisibleTurn(ctx: PiContext) {
    try {
      return applyCurrentToolPolicy(ctx);
    } catch (error) {
      if (isStaleExtensionContextError(error)) return undefined;
      throw error;
    }
  }

  function buildPromptAppend(ctx: PiContext, event: { systemPrompt: string }) {
    try {
      const { config, policy, activeAgent } = applyPolicySnapshot(ctx, {
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

  function applyPolicySnapshot(ctx: PiContext, resources: { skills?: string[] } = {}) {
    const snapshot = resolveCurrentPolicy(ctx, {
      tools: pi.getActiveTools(),
      skills: resources.skills ?? availableSkillNames(ctx),
    });
    currentAgentName = snapshot.policy.agentName;
    return snapshot;
  }

  async function loadDefaultAgent(ctx: PiContext, event: { reason?: string }) {
    const config = operations.load(ctx);
    const agentName = configuredDefaultAgent(config.settings);

    if (!agentName || !shouldApplyDefaultAgent(event, ctx.sessionManager)) return undefined;

    if (!config.agents.some((agent) => agent.name.toLowerCase() === agentName.toLowerCase())) {
      ctx.ui.notify(`pi-gentic defaultAgent "${agentName}" is not configured.`, "warning");
      await operations.applyCurrentPolicy(ctx);

      return undefined;
    }

    return operations.loadAgent(ctx, agentName, { enforceAccess: false });
  }

  async function cycleAgent(ctx: PiContext) {
    const config = operations.load(ctx);
    const agentName = nextAgentName(activeAgentName(ctx.sessionManager), config.agents);

    return operations.loadAgent(ctx, agentName ?? "clear");
  }

  async function loadAgent(ctx: PiContext, agentName: unknown, options: UnknownRecord = {}) {
    const config = operations.load(ctx);
    const clearing = !agentName || agentName === "clear";
    const agent = clearing
      ? undefined
      : options.enforceAccess === false
        ? config.agents.find((item) => item.name.toLowerCase() === String(agentName).toLowerCase())
        : operations.assertAgentAvailable(ctx, agentName, config);

    if (!clearing && !agent)
      throw new Error(
        `Unknown agent "${agentName}". Available agents: ${config.agents.map((item) => item.name).join(", ") || "none"}.`,
      );
    appendActiveState(ctx.sessionManager, {
      agentName: agent?.name,
      overrides: agent ? options.overrides : undefined,
    });
    const { policy } = await operations.applyCurrentPolicy(ctx);
    const sessionId = ctx.sessionManager.getSessionId();

    return {
      text: agent ? `Loaded ${agent.name} agent in session ${shortSessionId(sessionId)}.` : "Cleared active agent.",
      details: cardDetails("load", "done", {
        agentName: agent?.name ?? "agentless",
        sessionId,
        configuration: compactPolicy(policy),
        systemPrompt: resolvedPromptForCard(ctx, config, policy, agent),
      }),
    };
  }

  function resolvedPromptForCard(
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

  const operations = {
    get currentAgentName() {
      return currentAgentName;
    },
    load,
    getActiveAgent,
    resolvePolicy,
    availableAgents,
    assertAgentAvailable,
    applyCurrentPolicy,
    applyCurrentToolPolicy,
    reconcileSessionTools,
    setTitle,
    setAgentWidget,
    prepareVisibleTurn,
    buildPromptAppend,
    applyPolicySnapshot,
    loadDefaultAgent,
    cycleAgent,
    loadAgent,
    resolvedPromptForCard,
  };
  return operations;
}

export type AgentOperations = ReturnType<typeof createAgentOperations>;

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
