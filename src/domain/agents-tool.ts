import { Effect, Schema } from "effect";

const NonBlankString = Schema.String.check(Schema.isPattern(/\S/));
const Overrides = Schema.Record(Schema.String, Schema.Json);
const SendFields = {
  message: NonBlankString,
  agent: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  async: Schema.optionalKey(Schema.Boolean),
  fork: Schema.optionalKey(Schema.Boolean),
  cwd: Schema.optionalKey(Schema.String),
  worktree: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  invokeMeLater: Schema.optionalKey(Schema.Boolean),
  overrides: Schema.optionalKey(Overrides),
};

const ListInput = Schema.Struct({ action: Schema.Literal("list") });
const GetInput = Schema.Struct({
  action: Schema.Literal("get"),
  agent: NonBlankString,
});
const StatusInput = Schema.Struct({
  action: Schema.Literal("status"),
  sessionId: NonBlankString,
});
const LoadInput = Schema.Struct({
  action: Schema.Literal("load"),
  agent: NonBlankString,
  overrides: Schema.optionalKey(Overrides),
});
const SendInput = Schema.Struct({
  action: Schema.Literal("send"),
  ...SendFields,
});
const AbortInput = Schema.Struct({
  action: Schema.Literal("abort"),
  sessionId: Schema.optionalKey(Schema.String),
});
const DiscoverSessionsInput = Schema.Struct({
  action: Schema.Literal("discoverSessions"),
  rx: Schema.optionalKey(Schema.Finite),
  ry: Schema.optionalKey(Schema.Finite),
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

export class ListAgentsAction extends Schema.TaggedClass<ListAgentsAction>()(
  "ListAgentsAction",
  {},
) {}

export class GetAgentsAction extends Schema.TaggedClass<GetAgentsAction>()(
  "GetAgentsAction",
  { agent: Schema.String },
) {}

export class StatusAgentsAction extends Schema.TaggedClass<StatusAgentsAction>()(
  "StatusAgentsAction",
  { sessionId: Schema.String },
) {}

export class LoadAgentsAction extends Schema.TaggedClass<LoadAgentsAction>()(
  "LoadAgentsAction",
  {
    agent: Schema.String,
    overrides: Schema.optionalKey(Overrides),
  },
) {}

export class SendAgentsAction extends Schema.TaggedClass<SendAgentsAction>()(
  "SendAgentsAction",
  SendFields,
) {}

export class AbortAgentsAction extends Schema.TaggedClass<AbortAgentsAction>()(
  "AbortAgentsAction",
  { sessionId: Schema.optionalKey(Schema.String) },
) {}

export class DiscoverSessionsAction extends Schema.TaggedClass<DiscoverSessionsAction>()(
  "DiscoverSessionsAction",
  {
    rx: Schema.optionalKey(Schema.Finite),
    ry: Schema.optionalKey(Schema.Finite),
  },
) {}

export type AgentsToolInput =
  | ListAgentsAction
  | GetAgentsAction
  | StatusAgentsAction
  | LoadAgentsAction
  | SendAgentsAction
  | AbortAgentsAction
  | DiscoverSessionsAction;

export function agentsActionName(input: AgentsToolInput) {
  switch (input._tag) {
    case "ListAgentsAction":
      return "list";
    case "GetAgentsAction":
      return "get";
    case "StatusAgentsAction":
      return "status";
    case "LoadAgentsAction":
      return "load";
    case "SendAgentsAction":
      return "send";
    case "AbortAgentsAction":
      return "abort";
    case "DiscoverSessionsAction":
      return "discoverSessions";
  }
}

export const decodeAgentsToolInput = Effect.fn(
  "AgentsTool.decode",
)(function* (input: unknown) {
  const decoded = yield* Schema.decodeUnknownEffect(
    AgentsToolParametersSchema,
  )(input);

  return toAction(decoded);
});

export const normalizeAgentsToolInput = Effect.fn(
  "AgentsTool.normalize",
)(function* (input: unknown) {
  if (!isRecord(input)) return yield* decodeAgentsToolInput(input);
  const action =
    typeof input.action === "string" ? input.action.trim() : input.action;

  return yield* decodeAgentsToolInput({ ...input, action });
});

export function normalizeAgentsToolInputSync(input: unknown) {
  if (!isRecord(input))
    throw new Error("Tool input must be a JSON object.");
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
        ...(input.overrides === undefined
          ? {}
          : { overrides: input.overrides }),
      });
    case "send":
      return SendAgentsAction.make({
        message: input.message,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId }),
        ...(input.async === undefined ? {} : { async: input.async }),
        ...(input.fork === undefined ? {} : { fork: input.fork }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.worktree === undefined
          ? {}
          : { worktree: input.worktree }),
        ...(input.repo === undefined ? {} : { repo: input.repo }),
        ...(input.invokeMeLater === undefined
          ? {}
          : { invokeMeLater: input.invokeMeLater }),
        ...(input.overrides === undefined
          ? {}
          : { overrides: input.overrides }),
      });
    case "abort":
      return AbortAgentsAction.make(
        input.sessionId === undefined ? {} : { sessionId: input.sessionId },
      );
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
