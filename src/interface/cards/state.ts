import { Duration, Effect, Exit, Fiber, Schema } from "effect";
import { reportRuntimeDiagnostic } from "../../shared/diagnostics.js";
import type { PiSessionManager } from "../../infrastructure/pi/types.js";
import type { ExtensionRuntime } from "../../runtime/ExtensionRuntime.js";
import type { UnknownRecord } from "../../shared/types.js";
import { booleanValue, isRecord, stringValue } from "../../shared/value.js";

export const CARD_MESSAGE_TYPE = "pi-gentic:card";
export const CARD_STATE_ENTRY_TYPE = "pi-gentic:card-state";

const COMPLETED_CARD_TTL_MS = 60_000;
export const PersistedCardDetailsSchema = Schema.Record(Schema.String, Schema.UndefinedOr(Schema.Json));
export const MAX_CARD_ACTIVITY_LINES = 14;

const ACTIVE_CARD_STATUSES = new Set(["queued", "running"]);
const TERMINAL_CARD_STATUSES = new Set(["done", "error", "aborted", "stopped"]);
export interface CardDetails extends UnknownRecord {
  status?: string;
  kind?: string;
  cardId?: string;
  sessionId?: string;
  agentName?: string;
  message?: string;
  answer?: string;
  async?: boolean;
  live?: boolean;
  livePanel?: boolean;
  startedAt?: number;
  updatedAt?: number;
  completedAt?: number;
  inactiveMs?: number;
  activities?: UnknownRecord[];
  configuration?: UnknownRecord;
  sessions?: UnknownRecord[];
  systemPrompt?: string;
  error?: string;
  restored?: boolean;
  phase?: string;
  call?: UnknownRecord;
}

export function normalizeCardDetails(value: unknown): CardDetails {
  if (!isRecord(value)) return {};

  return {
    ...value,
    status: stringValue(value.status),
    kind: stringValue(value.kind),
    cardId: stringValue(value.cardId),
    sessionId: stringValue(value.sessionId),
    agentName: stringValue(value.agentName),
    message: stringValue(value.message),
    answer: stringValue(value.answer),
    async: booleanValue(value.async),
    live: booleanValue(value.live),
    livePanel: booleanValue(value.livePanel),
    startedAt: numberField(value.startedAt),
    updatedAt: numberField(value.updatedAt),
    completedAt: numberField(value.completedAt),
    inactiveMs: numberField(value.inactiveMs),
    activities: Array.isArray(value.activities) ? value.activities.filter(isRecord) : undefined,
    configuration: isRecord(value.configuration) ? value.configuration : undefined,
    sessions: Array.isArray(value.sessions) ? value.sessions.filter(isRecord) : undefined,
    systemPrompt: stringValue(value.systemPrompt),
    error: stringValue(value.error),
    restored: booleanValue(value.restored),
    phase: stringValue(value.phase),
    call: isRecord(value.call) ? value.call : undefined,
  };
}

function numberField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function prepareCardDetailsForHistory(details: UnknownRecord) {
  if (!Array.isArray(details.activities)) return { ...details };
  const { activityCount, ...historyDetails } = details;
  const activities = details.activities.filter(isRecord);
  const retainedActivities = activities.slice(-MAX_CARD_ACTIVITY_LINES);
  const recordedActivityCount = numberField(activityCount);

  return {
    ...historyDetails,
    activities: retainedActivities,
    ...(recordedActivityCount !== undefined || retainedActivities.length < activities.length
      ? { activityCount: Math.max(recordedActivityCount ?? 0, activities.length) }
      : {}),
  };
}

interface LiveCardEntry {
  readonly details: CardDetails;
  readonly token: symbol;
  readonly interruptExpiry?: () => void;
}

interface UiRuntimeState {
  readonly liveCards: Map<string, LiveCardEntry>;
  readonly persistedCards: Map<string, CardDetails>;
  readonly liveCardRefreshers: Set<(details?: UnknownRecord) => void>;
  livePanelStop?: () => void;
}

const UI_RUNTIME_KEY = Symbol.for("pi-gentic.ui-runtime");
const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
export const cardRuntime = (globalState[UI_RUNTIME_KEY] ??= {
  liveCards: new Map(),
  persistedCards: new Map(),
  liveCardRefreshers: new Set(),
}) as UiRuntimeState;
const { liveCards, persistedCards, liveCardRefreshers } = cardRuntime;

export function isActiveCard(details: CardDetails | undefined) {
  return typeof details?.status === "string" && ACTIVE_CARD_STATUSES.has(details.status);
}

export function isTerminalCard(details: CardDetails | undefined) {
  return typeof details?.status === "string" && TERMINAL_CARD_STATUSES.has(details.status);
}

export function liveCardKey(details: CardDetails | undefined) {
  if (!details) return undefined;

  return details.cardId ?? details.sessionId;
}

export function setLiveCardDetails(details: CardDetails, options: { ttlMs?: number; runtime?: ExtensionRuntime } = {}) {
  const key = liveCardKey(details);

  if (!key) return undefined;
  const existing = liveCards.get(key);

  existing?.interruptExpiry?.();
  const nextDetails = { ...existing?.details, ...details };
  const ttlMs = liveCardTtl(nextDetails, options.ttlMs);
  const token = Symbol(key);
  let interruptExpiry: (() => void) | undefined;

  if (ttlMs !== undefined && options.runtime) {
    const fiber = options.runtime.runFork(
      Effect.sleep(Duration.millis(ttlMs)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (liveCards.get(key)?.token === token) liveCards.delete(key);
          }),
        ),
      ),
    );
    interruptExpiry = () => {
      options.runtime?.runFork(Fiber.interrupt(fiber));
    };
  }

  liveCards.set(key, { details: nextDetails, token, interruptExpiry });
  notifyLiveCardRefreshers(nextDetails);

  return nextDetails;
}

export function getLiveCardDetails(details: CardDetails) {
  const key = liveCardKey(details);

  return key ? liveCards.get(key)?.details : undefined;
}

export function setPersistedCardDetails(details: CardDetails) {
  const key = liveCardKey(details);

  if (!key) return undefined;
  const nextDetails = { ...persistedCards.get(key), ...details };

  persistedCards.set(key, nextDetails);
  notifyLiveCardRefreshers(nextDetails);

  return nextDetails;
}

export function restorePersistedCardDetails(sessionManager: PiSessionManager) {
  const entries = sessionManager?.getBranch?.() ?? sessionManager?.getEntries?.() ?? [];

  for (const entry of entries) {
    if (!isRecord(entry) || entry.customType !== CARD_STATE_ENTRY_TYPE) continue;
    const decoded = Schema.decodeUnknownExit(PersistedCardDetailsSchema)(entry.data);

    if (Exit.isSuccess(decoded)) setPersistedCardDetails(normalizeCardDetails(decoded.value));
    else reportRuntimeDiagnostic("persisted-card-state", decoded.cause, "warning");
  }
}

function getPersistedCardDetails(details: CardDetails) {
  const key = liveCardKey(details);

  return key ? persistedCards.get(key) : undefined;
}

export function resolveCardDetails(details: CardDetails) {
  const persistedDetails = getPersistedCardDetails(details);
  const liveDetails = getLiveCardDetails(details);

  return {
    details: { ...details, ...persistedDetails, ...liveDetails },
    persistedDetails,
    liveDetails,
    live: isActiveCard(liveDetails),
  };
}

function notifyLiveCardRefreshers(details?: UnknownRecord) {
  for (const refresh of liveCardRefreshers) refresh(details);
}

function liveCardTtl(details: CardDetails, requestedTtl: unknown) {
  if (!details.completedAt && !isTerminalCard(details)) return undefined;

  return Math.max(100, Number(requestedTtl ?? COMPLETED_CARD_TTL_MS));
}
