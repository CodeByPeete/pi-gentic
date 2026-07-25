import { Schema } from "effect";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const SessionId = NonEmptyString.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const DelegationId = NonEmptyString.pipe(Schema.brand("DelegationId"));
export type DelegationId = typeof DelegationId.Type;

export const AgentName = NonEmptyString.pipe(Schema.brand("AgentName"));
export type AgentName = typeof AgentName.Type;
