import { Effect, Schema } from "effect";
import { isRecord } from "../shared/value.js";

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

export const AgentsToolParametersSchema = Schema.Union([...sharedActions, SendAction]);

export const ExistingSessionAgentsToolParametersSchema = Schema.Union([...sharedActions, ExistingSessionSendAction]);

export type AgentsToolInput = typeof AgentsToolParametersSchema.Type;

export const decodeAgentsToolInput = Schema.decodeUnknownEffect(AgentsToolParametersSchema);

export const normalizeAgentsToolInput = Effect.fn("AgentsTool.normalize")(function* (input: unknown) {
  return yield* decodeAgentsToolInput(normalizedAction(input));
});

function normalizedAction(input: unknown) {
  return isRecord(input) && typeof input.action === "string" ? { ...input, action: input.action.trim() } : input;
}
