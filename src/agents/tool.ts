import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import type { Orchestrator } from "../delegation/send.js";
import type { ExtensionRuntime } from "../extension-runtime.js";
import type { PiContext, PiSessionManager } from "../pi/types.js";
import { reportRuntimeDiagnostic } from "../shared/diagnostics.js";
import type { UnknownRecord } from "../shared/values.js";
import { errorMessage, isRecord } from "../shared/values.js";
import { renderAgentsCall, renderAgentsResult } from "../ui/card-renderer.js";

const NonBlankString = Schema.String.check(Schema.isPattern(/\S/));
const Overrides = Schema.Record(Schema.String, Schema.Json).annotate({
  description: "Configuration values applied to the selected agent or target session.",
});
const AgentName = NonBlankString.annotate({ description: "Name of a configured agent." });
const SessionReference = NonBlankString.annotate({ description: "Identifier of a durable agent session." });
const action = <const Name extends string>(name: Name, description: string) =>
  Schema.Literal(name).annotate({ description });
const optional = Schema.optionalKey;
const cwd = (description: string) => optional(Schema.String.annotate({ description }));

const sharedSendFields = {
  message: NonBlankString.annotate({ description: "Task or message delivered to the target session." }),
  agent: optional(AgentName),
  invokeMeLater: optional(
    Schema.Boolean.annotate({
      description: "Whether a completed asynchronous target may trigger a later caller turn.",
    }),
  ),
  overrides: optional(Overrides),
};
const sharedActions = [
  Schema.Struct({ action: action("list", "List available agents.") }),
  Schema.Struct({ action: action("get", "Read one agent definition."), agent: AgentName }),
  Schema.Struct({ action: action("status", "Read one session's current status."), sessionId: SessionReference }),
  Schema.Struct({
    action: action("load", "Set the active agent configuration."),
    agent: AgentName,
    overrides: optional(Overrides),
  }),
  Schema.Struct({ action: action("abort", "Stop an active session run."), sessionId: optional(SessionReference) }),
  Schema.Struct({
    action: action("discoverSessions", "Discover nearby orchestration sessions."),
    rx: optional(Schema.Finite.annotate({ description: "Horizontal discovery radius." })),
    ry: optional(Schema.Finite.annotate({ description: "Vertical discovery radius." })),
  }),
] as const;

const SendAction = Schema.Struct({
  action: action("send", "Deliver work to an existing or new child session."),
  ...sharedSendFields,
  sessionId: optional(
    SessionReference.annotate({
      description: "Existing target session identifier. Omit it to create a child session.",
    }),
  ),
  async: optional(
    Schema.Boolean.annotate({ description: "Whether the caller continues without waiting for the target result." }),
  ),
  fork: optional(
    Schema.Boolean.annotate({
      description:
        "Whether a new child copies the caller's completed earlier conversation. The current request is replaced by the child's assignment. This is independent of worktree creation.",
    }),
  ),
  cwd: cwd("Working directory for the target session or destination path for an explicitly configured worktree."),
  worktree: optional(
    Schema.Union([Schema.Literal(true), Schema.String]).annotate({
      description:
        "Git worktree request. A string selects the branch and true requests automatic branch and path generation.",
    }),
  ),
  repo: optional(
    Schema.String.annotate({ description: "Source Git repository used to create or resolve the worktree." }),
  ),
});
const ExistingSessionSendAction = Schema.Struct({
  action: action("send", "Deliver work to a different existing session."),
  ...sharedSendFields,
  sessionId: SessionReference.annotate({ description: "Existing target session identifier." }),
  cwd: cwd("Working directory for the target session."),
});

const AgentsToolParametersSchema = Schema.Union([...sharedActions, SendAction]);

const ExistingSessionAgentsToolParametersSchema = Schema.Union([...sharedActions, ExistingSessionSendAction]);

export type AgentsToolInput = typeof AgentsToolParametersSchema.Type;

export const decodeAgentsToolInput = Schema.decodeUnknownEffect(AgentsToolParametersSchema);

export const normalizeAgentsToolInput = Effect.fn("AgentsTool.normalize")(function* (input: unknown) {
  return yield* decodeAgentsToolInput(normalizedAction(input));
});

function normalizedAction(input: unknown) {
  return isRecord(input) && typeof input.action === "string" ? { ...input, action: input.action.trim() } : input;
}

function agentsToolDefinition(canCreateChildSession: boolean) {
  const send = canCreateChildSession
    ? "Send can target a different existing sessionId or create a child when sessionId is omitted."
    : "Send requires a different existing sessionId.";

  return {
    description: `Perform one pi-gentic orchestration action. ${send} Use one action per call. Do not send slash commands, prose wrappers, or shell commands as the action.`,
    promptSnippet:
      "Orchestrate durable pi-gentic agent sessions; reuse a different sessionId when continuing the same work",
    parameters: Tool.getJsonSchemaFromSchema(
      canCreateChildSession ? AgentsToolParametersSchema : ExistingSessionAgentsToolParametersSchema,
    ),
  };
}

export function installAgentsTool({
  pi,
  runtime,
  orchestrator,
  captureContext,
  delegationBoundaries,
}: {
  pi: ExtensionAPI;
  runtime: ExtensionRuntime;
  orchestrator: Orchestrator;
  captureContext: (ctx: PiContext) => unknown;
  delegationBoundaries: WeakMap<PiSessionManager, string | null>;
}) {
  let childSessionCreationExposed: boolean | undefined;

  const register = (canCreateChildSession: boolean) => {
    if (childSessionCreationExposed === canCreateChildSession) return;
    pi.registerTool({
      name: "agents",
      label: "Agents",
      ...agentsToolDefinition(canCreateChildSession),
      renderShell: "self",
      renderCall: renderAgentsCall,
      renderResult: renderAgentsResult,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        captureContext(ctx);
        try {
          const input = await runtime.runPromise(normalizeAgentsToolInput(params));
          const callerEntryId = ctx.sessionManager.getLeafId?.();
          const forkBoundaryEntryId =
            input.action === "send" ? delegationBoundaries.get(ctx.sessionManager) : undefined;
          const call = {
            toolCallId,
            ...(callerEntryId ? { callerEntryId } : {}),
            ...(forkBoundaryEntryId !== undefined ? { forkBoundaryEntryId } : {}),
            parameters: params,
          };
          const result = await executeAction(orchestrator, ctx, input, onUpdate, signal, call);
          if (input.action === "load") await synchronize(ctx);
          return {
            content: [
              { type: "text", text: typeof result.text === "string" ? result.text : String(result.text ?? "") },
            ],
            details: { ...result.details, call },
          };
        } catch (error) {
          throw new Error(errorMessage(error), { cause: error });
        }
      },
    });
    childSessionCreationExposed = canCreateChildSession;
  };

  const synchronize = async (ctx: PiContext) => {
    try {
      register(await orchestrator.canCreateChildSession(ctx));
    } catch (error) {
      reportRuntimeDiagnostic("agents-tool-capability", error);
      register(false);
    }
  };

  register(false);
  return synchronize;
}

async function executeAction(
  orchestrator: Orchestrator,
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
