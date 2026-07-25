import { Schema } from "effect";

const CauseField = Schema.optionalKey(Schema.Defect());

export class PathOutsideAllowedRoot extends Schema.TaggedErrorClass<PathOutsideAllowedRoot>()(
  "PathOutsideAllowedRoot",
  {
    message: Schema.String,
    path: Schema.String,
    allowedRoots: Schema.Array(Schema.String),
    cause: CauseField,
  },
) {}

export class WorktreeRepositoryInvalid extends Schema.TaggedErrorClass<WorktreeRepositoryInvalid>()(
  "WorktreeRepositoryInvalid",
  {
    message: Schema.String,
    repositoryPath: Schema.String,
    cause: CauseField,
  },
) {}

export class WorktreePathConflict extends Schema.TaggedErrorClass<WorktreePathConflict>()(
  "WorktreePathConflict",
  {
    message: Schema.String,
    worktreePath: Schema.String,
    cause: CauseField,
  },
) {}

export class GitCommandFailed extends Schema.TaggedErrorClass<GitCommandFailed>()(
  "GitCommandFailed",
  {
    message: Schema.String,
    cwd: Schema.String,
    args: Schema.Array(Schema.String),
    exitCode: Schema.optionalKey(Schema.Finite),
    stderr: Schema.optionalKey(Schema.String),
    cause: CauseField,
  },
) {}

export class HostVersionUnsupported extends Schema.TaggedErrorClass<HostVersionUnsupported>()(
  "HostVersionUnsupported",
  {
    message: Schema.String,
    supportedVersion: Schema.String,
    receivedVersion: Schema.String,
  },
) {}

export class HostCapabilityUnavailable extends Schema.TaggedErrorClass<HostCapabilityUnavailable>()(
  "HostCapabilityUnavailable",
  {
    message: Schema.String,
    capability: Schema.String,
    hostVersion: Schema.String,
  },
) {}

export class InvalidDelegationTransition extends Schema.TaggedErrorClass<InvalidDelegationTransition>()(
  "InvalidDelegationTransition",
  {
    message: Schema.String,
    from: Schema.String,
    event: Schema.String,
  },
) {}

export type WorktreeError =
  | PathOutsideAllowedRoot
  | WorktreeRepositoryInvalid
  | WorktreePathConflict
  | GitCommandFailed;
