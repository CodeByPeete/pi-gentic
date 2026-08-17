import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { PiGenticOrchestrator } from "../application/delegation/orchestrator.js";
import { agentsActionName, type AgentsToolInput } from "../domain/agents-tool.js";
import { loadConfiguration } from "../infrastructure/configuration/agents.js";
import type { PiContext } from "../infrastructure/pi/types.js";
import type { UnknownRecord } from "../shared/types.js";

export async function executeAction(
  orchestrator: PiGenticOrchestrator,
  ctx: PiContext,
  input: AgentsToolInput,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  signal: AbortSignal | undefined,
  call: UnknownRecord,
) {
  if (input._tag === "ListAgentsAction") {
    const config = trustedConfiguration(ctx);
    const agents = orchestrator.availableAgents(ctx, config);
    const text =
      agents.map((agent: UnknownRecord) => `${agent.name}: ${agent.description ?? ""}`).join("\n") ||
      "No agents configured.";

    return {
      text,
      details: orchestrator.cardDetails("list", "done", {
        configuration: {
          agents: agents.map((agent: UnknownRecord) => agent.name),
        },
      }),
    };
  }

  if (input._tag === "GetAgentsAction") {
    if (!input.agent) throw new Error('Field "agent" is required for get.');
    const config = trustedConfiguration(ctx);
    const agent = orchestrator.availableAgents(ctx, config).find((item: UnknownRecord) => item.name === input.agent);

    if (!agent) throw new Error(`Unknown or unavailable agent "${input.agent}".`);
    return {
      text: JSON.stringify(agent, null, 2),
      details: orchestrator.cardDetails("get", "done", {
        agentName: agent.name,
        configuration: agent,
      }),
    };
  }

  if (input._tag === "StatusAgentsAction") {
    if (!input.sessionId) throw new Error('Field "sessionId" is required for status.');
    const status = await orchestrator.status(ctx, input.sessionId);

    return {
      text: status.text,
      details: orchestrator.cardDetails("status", "done", {
        sessionId: status.sessionId,
        configuration: status,
      }),
    };
  }

  if (input._tag === "LoadAgentsAction") {
    return orchestrator.loadAgent(ctx, input.agent, {
      overrides: input.overrides,
    });
  }

  if (input._tag === "SendAgentsAction") {
    if (typeof input.message !== "string" || !input.message.trim())
      throw new Error('Field "message" is required for send.');
    return orchestrator.send(ctx, { ...input }, { onUpdate, signal, call });
  }

  if (input._tag === "AbortAgentsAction") {
    const text = await orchestrator.abort(ctx, input.sessionId);

    return {
      text,
      details: orchestrator.cardDetails("abort", "done", {
        sessionId: input.sessionId,
      }),
    };
  }

  if (input._tag === "DiscoverSessionsAction") {
    const result = await orchestrator.discoverSessions(ctx, {
      rx: input.rx,
      ry: input.ry,
    });

    return {
      text: JSON.stringify(result, null, 2),
      details: orchestrator.cardDetails("discoverSessions", "done", {
        configuration: result,
        sessions: result.sessions,
      }),
    };
  }

  throw new Error(`Unknown action "${agentsActionName(input)}".`);
}

export function trustedConfiguration(ctx: PiContext) {
  return loadConfiguration({
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted?.() === true,
  });
}
