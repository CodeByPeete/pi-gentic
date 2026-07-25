import { Context, Effect, HashMap, Layer, Option, Schema, Stream, SubscriptionRef } from "effect";
import { AgentName, SessionId } from "../../domain/identifiers.js";

export class RuntimeMetadata extends Schema.Class<RuntimeMetadata>("RuntimeMetadata")({
  sessionId: SessionId,
  parentSessionId: Schema.optionalKey(SessionId),
  agentName: Schema.optionalKey(AgentName),
  createdAt: Schema.Finite,
  lastActivityAt: Schema.Finite,
}) {}

export interface RuntimeRecord {
  readonly metadata: RuntimeMetadata;
  readonly runtime: object;
}

export class RuntimeRegistry extends Context.Service<
  RuntimeRegistry,
  {
    readonly register: (metadata: RuntimeMetadata, runtime: object) => Effect.Effect<void>;
    readonly get: (sessionId: SessionId) => Effect.Effect<Option.Option<RuntimeRecord>>;
    readonly touch: (sessionId: SessionId, lastActivityAt: number) => Effect.Effect<void>;
    readonly remove: (sessionId: SessionId) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<RuntimeRecord>>;
    readonly changes: Stream.Stream<ReadonlyArray<RuntimeRecord>>;
  }
>()("pi-gentic/RuntimeRegistry") {}

export const RuntimeRegistryLive = Layer.effect(
  RuntimeRegistry,
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make(HashMap.empty<SessionId, RuntimeRecord>());
    const values = (records: HashMap.HashMap<SessionId, RuntimeRecord>) => HashMap.toValues(records);

    return {
      register: Effect.fn("RuntimeRegistry.register")(function* (metadata: RuntimeMetadata, runtime: object) {
        yield* SubscriptionRef.update(state, (records) =>
          HashMap.set(records, metadata.sessionId, { metadata, runtime }),
        );
      }),
      get: Effect.fn("RuntimeRegistry.get")(function* (sessionId: SessionId) {
        const records = yield* SubscriptionRef.get(state);

        return HashMap.get(records, sessionId);
      }),
      touch: Effect.fn("RuntimeRegistry.touch")(function* (sessionId: SessionId, lastActivityAt: number) {
        yield* SubscriptionRef.update(state, (records) => {
          const current = HashMap.get(records, sessionId);

          if (Option.isNone(current)) return records;
          const metadata = RuntimeMetadata.make({
            ...current.value.metadata,
            lastActivityAt,
          });

          return HashMap.set(records, sessionId, {
            metadata,
            runtime: current.value.runtime,
          });
        });
      }),
      remove: Effect.fn("RuntimeRegistry.remove")(function* (sessionId: SessionId) {
        yield* SubscriptionRef.update(state, (records) => HashMap.remove(records, sessionId));
      }),
      list: SubscriptionRef.get(state).pipe(Effect.map(values)),
      changes: SubscriptionRef.changes(state).pipe(Stream.map(values)),
    };
  }),
);
