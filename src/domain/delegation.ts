import * as Result from "effect/Result";
import { Schema } from "effect";
import { InvalidDelegationTransition } from "./errors.js";
import { DelegationId, SessionId } from "./identifiers.js";

const IdentityFields = {
  delegationId: DelegationId,
  callerSessionId: SessionId,
  targetSessionId: SessionId,
};

export class DelegationQueued extends Schema.TaggedClass<DelegationQueued>()(
  "DelegationQueued",
  {
    ...IdentityFields,
    queuedAt: Schema.Finite,
  },
) {}

export class DelegationRunning extends Schema.TaggedClass<DelegationRunning>()(
  "DelegationRunning",
  {
    ...IdentityFields,
    queuedAt: Schema.Finite,
    startedAt: Schema.Finite,
  },
) {}

export class DelegationCompleted extends Schema.TaggedClass<DelegationCompleted>()(
  "DelegationCompleted",
  {
    ...IdentityFields,
    queuedAt: Schema.Finite,
    startedAt: Schema.Finite,
    completedAt: Schema.Finite,
    answer: Schema.String,
  },
) {}

export class DelegationFailed extends Schema.TaggedClass<DelegationFailed>()(
  "DelegationFailed",
  {
    ...IdentityFields,
    queuedAt: Schema.Finite,
    startedAt: Schema.Finite,
    completedAt: Schema.Finite,
    reason: Schema.String,
  },
) {}

export class DelegationStopped extends Schema.TaggedClass<DelegationStopped>()(
  "DelegationStopped",
  {
    ...IdentityFields,
    queuedAt: Schema.Finite,
    startedAt: Schema.Finite,
    completedAt: Schema.Finite,
    reason: Schema.String,
  },
) {}

export class DelegationAborted extends Schema.TaggedClass<DelegationAborted>()(
  "DelegationAborted",
  {
    ...IdentityFields,
    queuedAt: Schema.Finite,
    startedAt: Schema.optionalKey(Schema.Finite),
    completedAt: Schema.Finite,
    reason: Schema.String,
  },
) {}

export const DelegationState = Schema.Union([
  DelegationQueued,
  DelegationRunning,
  DelegationCompleted,
  DelegationFailed,
  DelegationStopped,
  DelegationAborted,
]);
export type DelegationState = typeof DelegationState.Type;

export class StartDelegation extends Schema.TaggedClass<StartDelegation>()(
  "StartDelegation",
  { startedAt: Schema.Finite },
) {}

export class CompleteDelegation extends Schema.TaggedClass<CompleteDelegation>()(
  "CompleteDelegation",
  { completedAt: Schema.Finite, answer: Schema.String },
) {}

export class FailDelegation extends Schema.TaggedClass<FailDelegation>()(
  "FailDelegation",
  { completedAt: Schema.Finite, reason: Schema.String },
) {}

export class StopDelegation extends Schema.TaggedClass<StopDelegation>()(
  "StopDelegation",
  { completedAt: Schema.Finite, reason: Schema.String },
) {}

export class AbortDelegation extends Schema.TaggedClass<AbortDelegation>()(
  "AbortDelegation",
  { completedAt: Schema.Finite, reason: Schema.String },
) {}

export const DelegationEvent = Schema.Union([
  StartDelegation,
  CompleteDelegation,
  FailDelegation,
  StopDelegation,
  AbortDelegation,
]);
export type DelegationEvent = typeof DelegationEvent.Type;

export function transitionDelegation(
  state: DelegationState,
  event: DelegationEvent,
): Result.Result<DelegationState, InvalidDelegationTransition> {
  if (state._tag === "DelegationQueued") {
    if (event._tag === "StartDelegation") {
      return Result.succeed(
        DelegationRunning.make({
          delegationId: state.delegationId,
          callerSessionId: state.callerSessionId,
          targetSessionId: state.targetSessionId,
          queuedAt: state.queuedAt,
          startedAt: event.startedAt,
        }),
      );
    }

    if (event._tag === "AbortDelegation") {
      return Result.succeed(
        DelegationAborted.make({
          delegationId: state.delegationId,
          callerSessionId: state.callerSessionId,
          targetSessionId: state.targetSessionId,
          queuedAt: state.queuedAt,
          completedAt: event.completedAt,
          reason: event.reason,
        }),
      );
    }
  }

  if (state._tag === "DelegationRunning") {
    const identity = {
      delegationId: state.delegationId,
      callerSessionId: state.callerSessionId,
      targetSessionId: state.targetSessionId,
      queuedAt: state.queuedAt,
      startedAt: state.startedAt,
    };

    if (event._tag === "CompleteDelegation") {
      return Result.succeed(
        DelegationCompleted.make({
          ...identity,
          completedAt: event.completedAt,
          answer: event.answer,
        }),
      );
    }

    if (event._tag === "FailDelegation") {
      return Result.succeed(
        DelegationFailed.make({
          ...identity,
          completedAt: event.completedAt,
          reason: event.reason,
        }),
      );
    }

    if (event._tag === "StopDelegation") {
      return Result.succeed(
        DelegationStopped.make({
          ...identity,
          completedAt: event.completedAt,
          reason: event.reason,
        }),
      );
    }

    if (event._tag === "AbortDelegation") {
      return Result.succeed(
        DelegationAborted.make({
          ...identity,
          completedAt: event.completedAt,
          reason: event.reason,
        }),
      );
    }
  }

  return Result.fail(
    InvalidDelegationTransition.make({
      message: `Cannot apply ${event._tag} to ${state._tag}.`,
      from: state._tag,
      event: event._tag,
    }),
  );
}
