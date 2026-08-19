import { type Component, type TUI } from "@earendil-works/pi-tui";
import { Duration, Effect, Exit, Fiber, Schedule, Schema } from "effect";
import { recoverDiagnostic, reportRuntimeDiagnostic } from "../shared/diagnostics.js";
import type { PiApi, PiContext, PiSessionManager, PiTheme } from "../pi/types.js";
import type { ExtensionRuntime } from "../extension-runtime.js";
import type { UnknownRecord } from "../shared/values.js";
import { booleanValue, formatDuration, isRecord, shortestUniqueSessionId, stringValue } from "../shared/values.js";
import {
  createAgentLabel,
  foreground,
  formatActivity,
  invisibleComponent,
  joinWithMiddle,
  normalizeInline,
  renderBordered,
  styleAgentName,
  timer,
} from "./terminal.js";

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

interface LiveRefreshOptions extends UnknownRecord {
  placement?: "aboveEditor" | "belowEditor";
  intervalMs?: number;
  pulseIntervalMs?: number;
  ttlMs?: number;
  trackLiveCards?: boolean;
  autoPulse?: boolean;
  resolveContext?: () => PiContext | undefined;
  createComponent?: (tui: TUI, theme: PiTheme) => Component;
  acceptsDetails?: (details?: UnknownRecord) => boolean;
  shouldPulse?: () => boolean;
}

export const AGENT_WIDGET_KEY = "pi-gentic-agent";
export const LIVE_REFRESH_WIDGET_KEY = "pi-gentic-live-refresh";

export function setAgentLabel(ctx: PiContext, agentName: unknown) {
  if (ctx.mode !== "tui" || typeof ctx.ui?.setWidget !== "function") return;
  const content = agentName ? () => createAgentLabel(agentName) : undefined;

  ctx.ui.setWidget(AGENT_WIDGET_KEY, content, { placement: "belowEditor" });
}

export function showCard(pi: PiApi, text: string, details: UnknownRecord) {
  pi.sendMessage({
    customType: CARD_MESSAGE_TYPE,
    content: text,
    display: true,
    details,
  });
}

export function startLiveRefresh(
  ctx: PiContext,
  runtime: ExtensionRuntime,
  key = "default",
  options: LiveRefreshOptions = {},
) {
  const noop = Object.assign(() => {}, {
    refresh: (_details?: UnknownRecord) => {},
  });

  if (ctx.mode !== "tui" || typeof ctx.ui?.setWidget !== "function") return noop;
  const widgetKey = `${LIVE_REFRESH_WIDGET_KEY}:${key}`;
  const placement = options.placement ?? "aboveEditor";
  const resolveContext = () => options.resolveContext?.() ?? ctx;
  const minIntervalMs = Math.max(16, Number(options.intervalMs ?? 16));
  let stopped = false;
  let pending = false;
  let mountedContext: PiContext | undefined;
  let tui: TUI | undefined;
  let lastRefreshAt = 0;
  let refreshFiber: Fiber.Fiber<void, never> | undefined;
  let pulseFiber: Fiber.Fiber<unknown, never> | undefined;
  let timeoutFiber: Fiber.Fiber<void, never> | undefined;
  const interrupt = (fiber: Fiber.Fiber<unknown, unknown> | undefined) => {
    if (fiber) runtime.runFork(Fiber.interrupt(fiber));
  };
  const clearRefresh = () => {
    interrupt(refreshFiber);
    refreshFiber = undefined;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cardRuntime.liveCardRefreshers.delete(stop.refresh);
    clearRefresh();
    interrupt(pulseFiber);
    interrupt(timeoutFiber);
    pulseFiber = undefined;
    timeoutFiber = undefined;

    try {
      mountedContext?.ui?.setWidget?.(widgetKey, undefined, { placement });
    } catch (error) {
      reportRuntimeDiagnostic("live-widget-unmount", error);
    }
  };
  const renderPulse = () => {
    pending = false;

    if (stopped) return;

    try {
      lastRefreshAt = Date.now();

      if (tui) {
        tui.requestRender?.();
        return;
      }
      const currentContext = resolveContext();

      if (!currentContext) return;
      mountedContext = currentContext;
      currentContext.ui?.setWidget?.(
        widgetKey,
        (nextTui: TUI, theme: PiTheme) => {
          tui = nextTui;

          return options.createComponent?.(nextTui, theme) ?? invisibleComponent();
        },
        { placement },
      );
    } catch (error) {
      reportRuntimeDiagnostic("live-widget-render", error);
      if (resolveContext() === ctx) stop();
    }
  };

  stop.refresh = (details?: UnknownRecord) => {
    if (stopped || pending || options.acceptsDetails?.(details) === false) return;
    const delay = Math.max(0, minIntervalMs - (Date.now() - lastRefreshAt));
    pending = true;
    clearRefresh();
    if (delay === 0) renderPulse();
    else
      refreshFiber = runtime.runFork(
        Effect.sleep(Duration.millis(delay)).pipe(Effect.andThen(Effect.sync(renderPulse))),
      );
  };

  if (options.trackLiveCards !== false) cardRuntime.liveCardRefreshers.add(stop.refresh);

  if (options.autoPulse !== false) {
    const interval = Math.max(250, Number(options.pulseIntervalMs ?? 1000));

    pulseFiber = runtime.runFork(
      Effect.sync(() => {
        if (options.shouldPulse?.() !== false) renderPulse();
      }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(interval)))),
    );
  }

  if (options.ttlMs !== undefined)
    timeoutFiber = runtime.runFork(
      Effect.sleep(Duration.millis(Math.max(1000, Number(options.ttlMs)))).pipe(Effect.andThen(Effect.sync(stop))),
    );

  return stop;
}

export function startSessionLiveCardRefresh(ctx: PiContext, runtime: ExtensionRuntime) {
  cardRuntime.livePanelStop?.();
  const stop = startLiveRefresh(ctx, runtime, "session-live-cards", {
    acceptsDetails: (details: UnknownRecord | undefined) => !details || cardBelongsToSession(ctx, details),
    createComponent: (tui: TUI, theme: PiTheme) => new LiveCardsPanel(ctx, tui, theme),
    shouldPulse: () => sessionLiveCardDetails(ctx).length > 0,
  });
  const ownedStop = () => {
    stop();
    if (cardRuntime.livePanelStop === ownedStop) delete cardRuntime.livePanelStop;
  };
  ownedStop.refresh = stop.refresh;
  cardRuntime.livePanelStop = ownedStop;
  ownedStop.refresh?.();

  return ownedStop;
}

function sessionLiveCardDetails(ctx: PiContext) {
  const cards = [...cardRuntime.liveCards.values()]
    .map((entry) => entry.details)
    .filter((details) => isActiveCard(details) && cardBelongsToSession(ctx, details))
    .sort(
      (left, right) => Number(left.startedAt ?? left.updatedAt ?? 0) - Number(right.startedAt ?? right.updatedAt ?? 0),
    );

  return [...new Map(cards.map((details) => [details.sessionId ?? liveCardKey(details), details])).values()];
}

function cardBelongsToSession(ctx: PiContext, details: UnknownRecord) {
  const sessionId = currentSessionId(ctx);

  if (details?.callerSessionId) return details.callerSessionId === sessionId;
  const key = liveCardKey(details);

  return Boolean(key && sessionCardKeys(ctx).has(key));
}

function currentSessionId(ctx: PiContext) {
  return recoverDiagnostic(
    "current-session-id",
    () => ctx.sessionManager?.getSessionId?.(),
    () => undefined,
  );
}

function sessionCardKeys(ctx: PiContext) {
  return recoverDiagnostic(
    "session-card-keys",
    () => {
      const entries = [...(ctx.sessionManager.getEntries?.() ?? []), ...(ctx.sessionManager.getBranch?.() ?? [])];
      const keys = new Set();

      for (const entry of entries.filter(isRecord)) {
        const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
        const details =
          entry.type === "custom_message" && entry.customType === CARD_MESSAGE_TYPE && entry.display !== false
            ? normalizeCardDetails(entry.details)
            : entry.type === "message" && message?.role === "toolResult" && message.toolName === "agents"
              ? normalizeCardDetails(message.details)
              : undefined;
        const key = liveCardKey(details);
        if (key) keys.add(key);
      }
      return keys;
    },
    () => new Set(),
  );
}

class LiveCardsPanel {
  ctx: PiContext;
  tui: TUI;
  theme: PiTheme;

  constructor(ctx: PiContext, tui: TUI, theme: PiTheme) {
    this.ctx = ctx;
    this.tui = tui;
    this.theme = theme;
  }

  invalidate() {}

  render(width: number) {
    const cards = sessionLiveCardDetails(this.ctx);

    if (cards.length === 0) return [];
    const terminalRows = Math.max(8, Number(this.tui.terminal?.rows ?? 24));
    const rowLimit = Math.max(1, terminalRows - 10);
    const truncated = cards.length > rowLimit;
    const visibleCount = truncated ? rowLimit - 1 : rowLimit;
    const visibleCards = visibleCount > 0 ? cards.slice(-visibleCount) : [];
    const hiddenCount = cards.length - visibleCards.length;
    const sessionIds = visibleCards.map((details) => details.sessionId);
    const rows = visibleCards.map((details) => this.cardRow(details, Math.max(10, width - 4), sessionIds));

    if (hiddenCount > 0)
      rows.unshift(
        foreground(this.theme, "dim", `… ${hiddenCount} earlier active card${hiddenCount === 1 ? "" : "s"}`),
      );

    return renderBordered(
      width,
      (text) => foreground(this.theme, "dim", text),
      () => rows,
    );
  }

  cardRow(details: UnknownRecord, width: number, sessionIds: unknown[]) {
    const queued = details.status === "queued";
    const indicator = queued ? foreground(this.theme, "accent", "○") : foreground(this.theme, "success", "●");
    const mode = foreground(this.theme, "accent", details.async ? "[ASYNC]" : "[SYNC]");
    const agent =
      details.agentName && details.agentName !== "agentless"
        ? styleAgentName(details.agentName)
        : this.theme.bold("agent");
    const session = details.sessionId
      ? foreground(this.theme, "dim", `(${shortestUniqueSessionId(details.sessionId, sessionIds)})`)
      : "";
    const activities = Array.isArray(details.activities) ? details.activities : [];
    const detail = normalizeInline(
      activities.length > 0
        ? formatActivity(activities.at(-1))
        : queued
          ? `Queued: ${details.message ?? ""}`
          : details.message,
    );
    const now = Date.now();
    const inactive = formatDuration(Math.max(0, now - Number(details.updatedAt ?? now)));
    const total = formatDuration(Math.max(0, now - Number(details.startedAt ?? now)));
    const left = `${indicator} ${mode} ${agent}${session ? ` ${session}` : ""}`;
    const middle = ` ${foreground(this.theme, "dim", "│")} ${detail}`;
    const right =
      `${foreground(this.theme, "dim", "idle")} ${timer(inactive)} ` +
      `${foreground(this.theme, "dim", "· total")} ${timer(total)}`;

    return joinWithMiddle(left, middle, right, width);
  }
}
