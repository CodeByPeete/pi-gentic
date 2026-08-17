import { Schema } from "effect";
import { DelegationId } from "./identifiers.js";

const Message = { message: Schema.String };
const Caused = { ...Message, cause: Schema.optionalKey(Schema.Defect()) };

export class PathOutsideAllowedRoot extends Schema.TaggedErrorClass<PathOutsideAllowedRoot>()(
  "PathOutsideAllowedRoot",
  {
    ...Caused,
    path: Schema.String,
    allowedRoots: Schema.Array(Schema.String),
  },
) {}

export class WorktreeRepositoryInvalid extends Schema.TaggedErrorClass<WorktreeRepositoryInvalid>()(
  "WorktreeRepositoryInvalid",
  {
    ...Caused,
    repositoryPath: Schema.String,
  },
) {}

export class WorktreePathConflict extends Schema.TaggedErrorClass<WorktreePathConflict>()("WorktreePathConflict", {
  ...Caused,
  worktreePath: Schema.String,
}) {}

export class GitCommandFailed extends Schema.TaggedErrorClass<GitCommandFailed>()("GitCommandFailed", {
  ...Caused,
  cwd: Schema.String,
  args: Schema.Array(Schema.String),
  exitCode: Schema.optionalKey(Schema.Finite),
  stderr: Schema.optionalKey(Schema.String),
}) {}

export class HostCapabilityUnavailable extends Schema.TaggedErrorClass<HostCapabilityUnavailable>()(
  "HostCapabilityUnavailable",
  {
    ...Message,
    capability: Schema.String,
  },
) {}

export class DelegationAlreadyRegistered extends Schema.TaggedErrorClass<DelegationAlreadyRegistered>()(
  "DelegationAlreadyRegistered",
  {
    ...Message,
    delegationId: DelegationId,
  },
) {}

export class AgentCallFailed extends Schema.TaggedErrorClass<AgentCallFailed>()("AgentCallFailed", Caused) {}

export type WorktreeError =
  | PathOutsideAllowedRoot
  | WorktreeRepositoryInvalid
  | WorktreePathConflict
  | GitCommandFailed;
