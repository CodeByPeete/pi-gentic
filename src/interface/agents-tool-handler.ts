import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { PiGenticOrchestrator } from "../application/delegation/orchestrator.js";
import type { AgentsToolInput } from "../domain/agents-tool.js";
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
  switch (input.action) {
    case "list": {
      const agents = orchestrator.availableAgents(ctx, orchestrator.load(ctx));
      return {
        text: agents.map((agent) => `${agent.name}: ${agent.description ?? ""}`).join("\n") || "No agents configured.",
        details: orchestrator.cardDetails("list", "done", {
          configuration: { agents: agents.map((agent) => agent.name) },
        }),
      };
    }
    case "get": {
      const agent = orchestrator
        .availableAgents(ctx, orchestrator.load(ctx))
        .find((candidate) => candidate.name === input.agent);

      if (!agent) throw new Error(`Unknown or unavailable agent "${input.agent}".`);
      return {
        text: JSON.stringify(agent, null, 2),
        details: orchestrator.cardDetails("get", "done", {
          agentName: agent.name,
          configuration: agent,
        }),
      };
    }
    case "status": {
      const status = await orchestrator.status(ctx, input.sessionId);
      return {
        text: status.text,
        details: orchestrator.cardDetails("status", "done", {
          sessionId: status.sessionId,
          configuration: status,
        }),
      };
    }
    case "load":
      return orchestrator.loadAgent(ctx, input.agent, { overrides: input.overrides });
    case "send":
      return orchestrator.send(ctx, input, { onUpdate, signal, call });
    case "abort": {
      const text = await orchestrator.abort(ctx, input.sessionId);
      return {
        text,
        details: orchestrator.cardDetails("abort", "done", { sessionId: input.sessionId }),
      };
    }
    case "discoverSessions": {
      const result = await orchestrator.discoverSessions(ctx, input);
      return {
        text: JSON.stringify(result, null, 2),
        details: orchestrator.cardDetails("discoverSessions", "done", {
          configuration: result,
          sessions: result.sessions,
        }),
      };
    }
  }
}
