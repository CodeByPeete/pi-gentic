import { Effect, Match, Schema, pipe } from "effect";

const NonBlankString = Schema.String.check(Schema.isPattern(/\S/));
const Overrides = Schema.Record(Schema.String, Schema.Json).annotate({
  description: "Configuration values applied to the selected agent or target session.",
});
const AgentName = NonBlankString.annotate({ description: "Name of a configured agent." });
const SessionReference = NonBlankString.annotate({ description: "Identifier of a durable agent session." });
const SendFields = {
  message: NonBlankString.annotate({ description: "Task or message delivered to the target session." }),
  agent: Schema.optionalKey(AgentName),
  sessionId: Schema.optionalKey(
    SessionReference.annotate({
      description: "Existing target session identifier. Omit it to create a child session.",
    }),
  ),
  async: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Whether the caller continues without waiting for the target result." }),
  ),
  fork: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Whether a new child copies the caller's active conversation branch. This is independent of worktree creation.",
    }),
  ),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Working directory for the target session or destination path for an explicitly configured worktree.",
    }),
  ),
  worktree: Schema.optionalKey(
    Schema.Union([Schema.Literal(true), Schema.String]).annotate({
      description:
        "Git worktree request. A string selects the branch and true requests automatic branch and path generation.",
    }),
  ),
  repo: Schema.optionalKey(
    Schema.String.annotate({ description: "Source Git repository used to create or resolve the worktree." }),
  ),
  invokeMeLater: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Whether a completed asynchronous target may trigger a later caller turn.",
    }),
  ),
  overrides: Schema.optionalKey(Overrides),
};

const ListInput = Schema.Struct({
  action: Schema.Literal("list").annotate({ description: "List available agents." }),
});
const GetInput = Schema.Struct({
  action: Schema.Literal("get").annotate({ description: "Read one agent definition." }),
  agent: AgentName,
});
const StatusInput = Schema.Struct({
  action: Schema.Literal("status").annotate({ description: "Read one session's current status." }),
  sessionId: SessionReference,
});
const LoadInput = Schema.Struct({
  action: Schema.Literal("load").annotate({ description: "Set the active agent configuration." }),
  agent: AgentName,
  overrides: Schema.optionalKey(Overrides),
});
const SendInput = Schema.Struct({
  action: Schema.Literal("send").annotate({ description: "Deliver work to an existing or new child session." }),
  ...SendFields,
});
const AbortInput = Schema.Struct({
  action: Schema.Literal("abort").annotate({ description: "Stop an active session run." }),
  sessionId: Schema.optionalKey(SessionReference),
});
const DiscoverSessionsInput = Schema.Struct({
  action: Schema.Literal("discoverSessions").annotate({ description: "Discover nearby orchestration sessions." }),
  rx: Schema.optionalKey(Schema.Finite.annotate({ description: "Horizontal discovery radius." })),
  ry: Schema.optionalKey(Schema.Finite.annotate({ description: "Vertical discovery radius." })),
});

export const AgentsToolParametersSchema = Schema.Union([
  ListInput,
  GetInput,
  StatusInput,
  LoadInput,
  SendInput,
  AbortInput,
  DiscoverSessionsInput,
]);

type DecodedAgentsToolInput = typeof AgentsToolParametersSchema.Type;

export class ListAgentsAction extends Schema.TaggedClass<ListAgentsAction>()("ListAgentsAction", {}) {}

export class GetAgentsAction extends Schema.TaggedClass<GetAgentsAction>()("GetAgentsAction", {
  agent: Schema.String,
}) {}

export class StatusAgentsAction extends Schema.TaggedClass<StatusAgentsAction>()("StatusAgentsAction", {
  sessionId: Schema.String,
}) {}

export class LoadAgentsAction extends Schema.TaggedClass<LoadAgentsAction>()("LoadAgentsAction", {
  agent: Schema.String,
  overrides: Schema.optionalKey(Overrides),
}) {}

export class SendAgentsAction extends Schema.TaggedClass<SendAgentsAction>()("SendAgentsAction", SendFields) {}

export class AbortAgentsAction extends Schema.TaggedClass<AbortAgentsAction>()("AbortAgentsAction", {
  sessionId: Schema.optionalKey(Schema.String),
}) {}

export class DiscoverSessionsAction extends Schema.TaggedClass<DiscoverSessionsAction>()("DiscoverSessionsAction", {
  rx: Schema.optionalKey(Schema.Finite),
  ry: Schema.optionalKey(Schema.Finite),
}) {}

export type AgentsToolInput =
  | ListAgentsAction
  | GetAgentsAction
  | StatusAgentsAction
  | LoadAgentsAction
  | SendAgentsAction
  | AbortAgentsAction
  | DiscoverSessionsAction;

export function agentsActionName(input: AgentsToolInput) {
  return pipe(
    Match.value(input),
    Match.tagsExhaustive({
      ListAgentsAction: () => "list",
      GetAgentsAction: () => "get",
      StatusAgentsAction: () => "status",
      LoadAgentsAction: () => "load",
      SendAgentsAction: () => "send",
      AbortAgentsAction: () => "abort",
      DiscoverSessionsAction: () => "discoverSessions",
    }),
  );
}

export const decodeAgentsToolInput = Effect.fn("AgentsTool.decode")(function* (input: unknown) {
  const decoded = yield* Schema.decodeUnknownEffect(AgentsToolParametersSchema)(input);

  return toAction(decoded);
});

export const normalizeAgentsToolInput = Effect.fn("AgentsTool.normalize")(function* (input: unknown) {
  if (!isRecord(input)) return yield* decodeAgentsToolInput(input);
  const action = typeof input.action === "string" ? input.action.trim() : input.action;

  return yield* decodeAgentsToolInput({ ...input, action });
});

export function normalizeAgentsToolInputSync(input: unknown) {
  if (!isRecord(input)) throw new Error("Tool input must be a JSON object.");
  if (typeof input.action !== "string" || input.action.trim().length === 0)
    throw new Error('Missing required field "action".');
  const decoded = Schema.decodeUnknownSync(AgentsToolParametersSchema)({
    ...input,
    action: input.action.trim(),
  });

  return toAction(decoded);
}

function toAction(input: DecodedAgentsToolInput): AgentsToolInput {
  switch (input.action) {
    case "list":
      return ListAgentsAction.make({});
    case "get":
      return GetAgentsAction.make({ agent: input.agent });
    case "status":
      return StatusAgentsAction.make({ sessionId: input.sessionId });
    case "load":
      return LoadAgentsAction.make({
        agent: input.agent,
        ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
      });
    case "send":
      return SendAgentsAction.make({
        message: input.message,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.async === undefined ? {} : { async: input.async }),
        ...(input.fork === undefined ? {} : { fork: input.fork }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
        ...(input.repo === undefined ? {} : { repo: input.repo }),
        ...(input.invokeMeLater === undefined ? {} : { invokeMeLater: input.invokeMeLater }),
        ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
      });
    case "abort":
      return AbortAgentsAction.make(input.sessionId === undefined ? {} : { sessionId: input.sessionId });
    case "discoverSessions":
      return DiscoverSessionsAction.make({
        ...(input.rx === undefined ? {} : { rx: input.rx }),
        ...(input.ry === undefined ? {} : { ry: input.ry }),
      });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
