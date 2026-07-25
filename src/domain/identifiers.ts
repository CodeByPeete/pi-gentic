import { Schema } from "effect";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const SessionId = NonEmptyString.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const DelegationId = NonEmptyString.pipe(Schema.brand("DelegationId"));
export type DelegationId = typeof DelegationId.Type;

export const CardId = NonEmptyString.pipe(Schema.brand("CardId"));
export type CardId = typeof CardId.Type;

export const AgentName = NonEmptyString.pipe(Schema.brand("AgentName"));
export type AgentName = typeof AgentName.Type;

export const SessionPath = NonEmptyString.pipe(Schema.brand("SessionPath"));
export type SessionPath = typeof SessionPath.Type;

export const RepositoryRoot = NonEmptyString.pipe(Schema.brand("RepositoryRoot"));
export type RepositoryRoot = typeof RepositoryRoot.Type;

export const WorktreePath = NonEmptyString.pipe(Schema.brand("WorktreePath"));
export type WorktreePath = typeof WorktreePath.Type;
