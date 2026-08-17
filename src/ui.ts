import { isDeepStrictEqual } from "node:util";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { Duration, Effect, Exit, Fiber, Schedule, Schema } from "effect";
import { formatDuration, isRecord, shortestUniqueSessionId, shortSessionId } from "./catalog.js";
import { reportRuntimeDiagnostic } from "./diagnostics.js";
import type { PiApi, PiContext, PiSessionManager, PiTheme, UnknownRecord } from "./pi-types.js";
import type { ExtensionRuntime } from "./runtime/ExtensionRuntime.js";

const COMPLETED_CARD_TTL_MS = 60_000;
export const PersistedCardDetailsSchema = Schema.Record(Schema.String, Schema.UndefinedOr(Schema.Json));
export const MAX_CARD_ACTIVITY_LINES = 14;

const ACTIVE_CARD_STATUSES = new Set(["queued", "running"]);
const TERMINAL_CARD_STATUSES = new Set(["done", "error", "aborted", "stopped"]);
interface CardDetails extends UnknownRecord {
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

function normalizeCardDetails(value: unknown): CardDetails {
  if (!isRecord(value)) return {};

  return {
    ...value,
    status: stringField(value.status),
    kind: stringField(value.kind),
    cardId: stringField(value.cardId),
    sessionId: stringField(value.sessionId),
    agentName: stringField(value.agentName),
    message: stringField(value.message),
    answer: stringField(value.answer),
    async: booleanField(value.async),
    live: booleanField(value.live),
    livePanel: booleanField(value.livePanel),
    startedAt: numberField(value.startedAt),
    updatedAt: numberField(value.updatedAt),
    completedAt: numberField(value.completedAt),
    inactiveMs: numberField(value.inactiveMs),
    activities: Array.isArray(value.activities) ? value.activities.filter(isRecord) : undefined,
    configuration: isRecord(value.configuration) ? value.configuration : undefined,
    sessions: Array.isArray(value.sessions) ? value.sessions.filter(isRecord) : undefined,
    systemPrompt: stringField(value.systemPrompt),
    error: stringField(value.error),
    restored: booleanField(value.restored),
    phase: stringField(value.phase),
    call: isRecord(value.call) ? value.call : undefined,
  };
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function booleanField(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
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
const uiRuntime = (globalState[UI_RUNTIME_KEY] ??= {
  liveCards: new Map(),
  persistedCards: new Map(),
  liveCardRefreshers: new Set(),
}) as UiRuntimeState;
const { liveCards, persistedCards, liveCardRefreshers } = uiRuntime;

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
  const nextDetails = { ...(existing?.details ?? {}), ...details };
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
  const nextDetails = { ...(persistedCards.get(key) ?? {}), ...details };

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

function resolveCardDetails(details: CardDetails) {
  const persistedDetails = getPersistedCardDetails(details);
  const liveDetails = getLiveCardDetails(details);

  return {
    details: { ...details, ...(persistedDetails ?? {}), ...(liveDetails ?? {}) },
    persistedDetails,
    liveDetails,
    live: isActiveCard(liveDetails),
  };
}

export function clearLiveCardDetails(details: CardDetails) {
  const key = liveCardKey(details);
  const entry = key ? liveCards.get(key) : undefined;

  entry?.interruptExpiry?.();

  if (key) liveCards.delete(key);

  notifyLiveCardRefreshers(entry?.details ?? details);
}

function notifyLiveCardRefreshers(details?: UnknownRecord) {
  for (const refresh of liveCardRefreshers) refresh(details);
}

function liveCardTtl(details: CardDetails, requestedTtl: unknown) {
  if (!details.completedAt && !isTerminalCard(details)) return undefined;

  return Math.max(100, Number(requestedTtl ?? COMPLETED_CARD_TTL_MS));
}

export function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleLength(text)) / 2));

  return fit(`${" ".repeat(padding)}${text}`, width);
}

function renderBordered(
  width: number,
  colorBorder: (text: string) => string,
  content: (innerWidth: number) => string[],
) {
  const innerWidth = Math.max(10, width - 4);

  return [
    colorBorder(`╭${"─".repeat(Math.max(0, width - 2))}╮`),
    ...content(innerWidth).map((line) => colorBorder("│ ") + fit(line, innerWidth) + colorBorder(" │")),
    colorBorder(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
  ];
}

export function joinWithRight(left: string, right: string, width: number) {
  if (!right) return fit(left, width);
  const rightWidth = visibleLength(right);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  const fittedLeft = fit(left, leftWidth);

  return `${fittedLeft}${" ".repeat(Math.max(1, width - visibleLength(fittedLeft) - rightWidth))}${right}`;
}

export function joinWithMiddle(left: string, middle: string, right: string, width: number) {
  const rightWidth = visibleLength(right);
  const leftAreaWidth = Math.max(0, width - rightWidth - 1);
  const middleWidth = Math.max(0, leftAreaWidth - visibleLength(left));
  const fittedLeft = middleWidth > 0 ? `${left}${fit(middle, middleWidth)}` : fit(left, leftAreaWidth);

  return `${fittedLeft}${" ".repeat(Math.max(1, width - visibleLength(fittedLeft) - rightWidth))}${right}`;
}

export function normalizeInline(text: unknown) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function wrap(text: unknown, width: number) {
  const clean = String(text ?? "");

  return clean.length === 0 ? [] : wrapTextWithAnsi(clean, width);
}

export function fit(text: unknown, width: number) {
  return width <= 0 ? "" : truncateToWidth(String(text ?? ""), width, "…", true);
}

export function visibleLength(text: unknown) {
  return visibleWidth(String(text ?? ""));
}

export const AGENT_WIDGET_KEY = "pi-gentic-agent";

export const CARD_MESSAGE_TYPE = "pi-gentic:card";

export const CARD_STATE_ENTRY_TYPE = "pi-gentic:card-state";

export const LIVE_REFRESH_WIDGET_KEY = "pi-gentic-live-refresh";

const AGENT_COLORS = [36, 92, 95, 93, 91, 94, 96, 33];

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
    liveCardRefreshers.delete(stop.refresh);
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

  if (options.trackLiveCards !== false) liveCardRefreshers.add(stop.refresh);

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
  uiRuntime.livePanelStop?.();
  const stop = startLiveRefresh(ctx, runtime, "session-live-cards", {
    acceptsDetails: (details: UnknownRecord | undefined) => !details || cardBelongsToSession(ctx, details),
    createComponent: (tui: TUI, theme: PiTheme) => new LiveCardsPanel(ctx, tui, theme),
    shouldPulse: () => sessionLiveCardDetails(ctx).length > 0,
  });
  const ownedStop = () => {
    stop();
    if (uiRuntime.livePanelStop === ownedStop) delete uiRuntime.livePanelStop;
  };
  ownedStop.refresh = stop.refresh;
  uiRuntime.livePanelStop = ownedStop;
  ownedStop.refresh?.();

  return ownedStop;
}

export function sessionHasVisibleLiveCard(ctx: PiContext) {
  return sessionLiveCardDetails(ctx).length > 0;
}

function sessionLiveCardDetails(ctx: PiContext) {
  const cards = [...liveCards.values()]
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
  try {
    return ctx.sessionManager?.getSessionId?.();
  } catch (error) {
    reportRuntimeDiagnostic("current-session-id", error);
    return undefined;
  }
}

function sessionCardKeys(ctx: PiContext) {
  const keys = new Set();
  let entries: UnknownRecord[] = [];

  try {
    const sessionEntries = [
      ...(ctx.sessionManager?.getEntries?.() ?? []),
      ...(ctx.sessionManager?.getBranch?.() ?? []),
    ];
    entries = sessionEntries.flatMap((entry) => (isRecord(entry) ? [entry] : []));
  } catch (error) {
    reportRuntimeDiagnostic("session-card-keys", error);
    return keys;
  }

  for (const entry of entries) {
    const message = isRecord(entry.message) ? entry.message : undefined;
    const details =
      entry?.type === "custom_message" && entry.customType === CARD_MESSAGE_TYPE && entry.display !== false
        ? normalizeCardDetails(entry.details)
        : entry?.type === "message" && message?.role === "toolResult" && message.toolName === "agents"
          ? normalizeCardDetails(message.details)
          : undefined;
    const key = liveCardKey(details);

    if (key) keys.add(key);
  }

  return keys;
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

    if (hiddenCount > 0) rows.unshift(this.dim(`… ${hiddenCount} earlier active card${hiddenCount === 1 ? "" : "s"}`));

    return renderBordered(
      width,
      (text) => this.dim(text),
      () => rows,
    );
  }

  cardRow(details: UnknownRecord, width: number, sessionIds: unknown[]) {
    const queued = details.status === "queued";
    const indicator = queued ? this.accent("○") : this.success("●");
    const mode = this.accent(details.async ? "[ASYNC]" : "[SYNC]");
    const agent =
      details.agentName && details.agentName !== "agentless" ? styleAgentName(details.agentName) : this.bold("agent");
    const session = details.sessionId ? this.dim(`(${shortestUniqueSessionId(details.sessionId, sessionIds)})`) : "";
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
    const middle = ` ${this.dim("│")} ${detail}`;
    const right = `${this.dim("idle")} ${this.timer(inactive)} ` + `${this.dim("· total")} ${this.timer(total)}`;

    return joinWithMiddle(left, middle, right, width);
  }

  bold(text: string) {
    return this.theme.bold(text);
  }

  accent(text: string) {
    return this.theme.fg("accent", text);
  }

  success(text: string) {
    return this.theme.fg("success", text);
  }

  dim(text: string) {
    return this.theme.fg("dim", text);
  }

  timer(text: string) {
    return `\x1b[95m${text}\x1b[39m`;
  }
}

export function styleAgentName(agentName: unknown, { bracketed = false }: UnknownRecord = {}) {
  const text = bracketed ? `[${agentName}]` : agentName;

  return `\x1b[${agentColorCode(agentName)}m${text}\x1b[39m`;
}

export function agentColorCode(agentName: unknown) {
  return AGENT_COLORS[hashString(String(agentName ?? "")) % AGENT_COLORS.length];
}

function createAgentLabel(agentName: unknown) {
  return {
    invalidate() {},
    render(width: number) {
      return [rightAlign(styleAgentName(agentName), width)];
    },
  };
}

function invisibleComponent() {
  return {
    invalidate() {},
    render() {
      return [];
    },
  };
}

function rightAlign(text: string, width: number) {
  return `${" ".repeat(Math.max(0, width - ansiVisibleLength(text)))}${text}`;
}

function ansiVisibleLength(text: string) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function hashString(text: string) {
  let hash = 0;

  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;

  return hash;
}

export const SESSION_TREE_VISIBLE_ITEMS = 12;

function sessionTreeConnector(session: UnknownRecord) {
  const depth = Math.max(0, Number(session.depth ?? 0));

  return depth === 0 ? "" : `${"│  ".repeat(Math.max(0, depth - 1))}${session.isLast === true ? "└─" : "├─"} `;
}

function sessionMessage(session: UnknownRecord) {
  return normalizeInline(session.lastMessage ?? session.firstMessage ?? session.name ?? "Untitled session");
}

function visibleSessionId(session: UnknownRecord, sessions: UnknownRecord[]) {
  return shortestUniqueSessionId(
    session.sessionId ?? session.id,
    sessions.map((item) => item.sessionId ?? item.id),
  );
}

export function renderAgentsCall(argsValue: unknown, theme: PiTheme, contextValue: unknown) {
  const args = isRecord(argsValue) ? argsValue : {};
  const context = isRecord(contextValue) ? contextValue : {};
  const card = new AgentsCard(theme);
  const toolCallId = stringField(context.toolCallId);

  card.update(
    {
      phase: "call",
      kind: typeof args.action === "string" ? args.action : "agents",
      status: "running",
      message: typeof args.message === "string" ? args.message : undefined,
      agentName: typeof args.agent === "string" ? args.agent : undefined,
      sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
      async: args.async === true,
      call: {
        ...(toolCallId ? { toolCallId } : {}),
        parameters: args,
      },
    },
    context.expanded === true,
  );

  return card;
}

export function renderAgentsResult(resultValue: unknown, optionsValue: unknown, theme: PiTheme, contextValue: unknown) {
  const result = isRecord(resultValue) ? resultValue : {};
  const options = isRecord(optionsValue) ? optionsValue : {};
  const context = isRecord(contextValue) ? contextValue : {};
  const previous = context.lastComponent;
  const previousCard = previous instanceof AgentsCard ? previous : undefined;
  const card = previousCard ?? new AgentsCard(theme);
  const originalDetails = normalizeCardDetails(result.details);
  const args = isRecord(context.args) ? context.args : {};
  const { details, liveDetails, live } = resolveCardDetails(originalDetails);

  if (isActiveCard(originalDetails) && details.livePanel === true) return new InvisibleComponent();
  const restoredRunning = details.status === "running" && !options.isPartial && !liveDetails;

  card.update(
    {
      cardId: details.cardId,
      kind: details.kind ?? (typeof args.action === "string" ? args.action : "agents"),
      live,
      restored: restoredRunning,
      status: restoredRunning
        ? "restored"
        : options.isPartial
          ? (details.status ?? "running")
          : (details.status ?? (context.isError ? "error" : "done")),
      async: details.async ?? args.async === true,
      agentName: details.agentName ?? (typeof args.agent === "string" ? args.agent : undefined),
      sessionId: details.sessionId ?? (typeof args.sessionId === "string" ? args.sessionId : undefined),
      message:
        details.message ?? (typeof args.message === "string" ? args.message : undefined) ?? firstText(result.content),
      answer:
        details.answer ??
        (details.kind === "send" && details.status === "done" ? firstText(result.content) : undefined),
      activities: details.activities ?? [],
      activityCount: details.activityCount,
      startedAt:
        details.startedAt ??
        previousCard?.data?.startedAt ??
        (details.kind === "send" && details.status === "running" ? Date.now() : undefined),
      updatedAt: details.updatedAt ?? previousCard?.data?.updatedAt,
      completedAt: restoredRunning
        ? (details.completedAt ?? details.updatedAt ?? details.startedAt)
        : details.completedAt,
      error: details.error ?? (context.isError ? firstText(result.content) : undefined),
      configuration: details.configuration,
      sessions:
        details.sessions ??
        (Array.isArray(details.configuration?.sessions) ? details.configuration.sessions.filter(isRecord) : undefined),
      systemPrompt: details.systemPrompt,
      phase: "result",
      call:
        details.call ?? previousCard?.data?.call ?? (Object.keys(args).length > 0 ? { parameters: args } : undefined),
    },
    options.expanded === true,
  );

  return card;
}

function firstText(content: unknown) {
  return Array.isArray(content) ? content.find((item) => item.type === "text")?.text : undefined;
}

class InvisibleComponent {
  invalidate() {}

  render() {
    return [];
  }
}

interface CardRenderCache {
  readonly width: number;
  readonly data: CardDetails;
  readonly persistedDetails?: CardDetails;
  readonly liveDetails?: CardDetails;
  readonly lines: string[];
}

class AgentsCard {
  theme: PiTheme;
  data: CardDetails;
  expanded: boolean;
  renderCache?: CardRenderCache;

  constructor(theme: PiTheme) {
    this.theme = theme;
    this.data = {};
    this.expanded = false;
  }

  update(data: CardDetails, expanded: boolean) {
    this.data = data;
    this.expanded = expanded;
    this.renderCache = undefined;
  }

  invalidate() {
    this.renderCache = undefined;
  }

  render(width: number) {
    const { details, liveDetails, persistedDetails, live } = resolveCardDetails(this.data);
    const cache = this.renderCache;

    if (
      cache?.width === width &&
      cache.data === this.data &&
      cache.persistedDetails === persistedDetails &&
      cache.liveDetails === liveDetails
    )
      return cache.lines;

    const staleRunning = details.status === "running" && !live;
    this.data = {
      ...details,
      live,
      restored: staleRunning ? true : liveDetails || persistedDetails ? false : details.restored,
      status: staleRunning ? "restored" : details.status,
      completedAt: staleRunning ? (details.completedAt ?? details.updatedAt ?? details.startedAt) : details.completedAt,
    };
    const lines = renderBordered(
      width,
      (text) => this.colorBorder(text),
      (innerWidth) => this.buildLines(innerWidth),
    );

    this.renderCache = { width, data: this.data, persistedDetails, liveDetails, lines };

    return lines;
  }

  buildLines(width: number) {
    const header = this.header(width);

    if (!this.expanded) return [header];

    return [header, "", ...this.body(width).flatMap((line) => wrap(line, width)), "", this.footer(width)];
  }

  header(width: number) {
    const icon = this.statusIcon();
    const async = this.data.async ? `${this.purple("[ASYNC]")} ` : "";
    const title = this.title();
    const agent =
      this.data.agentName && this.data.agentName !== "agentless" ? ` ${this.agent(this.data.agentName)}` : "";
    const session = this.data.sessionId ? ` ${this.dim(`(${shortSessionId(this.data.sessionId)})`)}` : "";

    return fit(`${icon} ${async}${this.bold(title)}${agent}${session}`, width);
  }

  title() {
    if (this.data.phase === "call") return "Agent call";

    if (this.data.status === "error") return "Agent call failed.";

    if (this.data.status === "stopped") return "Agent stopped before answering.";

    if (this.data.status === "aborted") return "Agent got aborted.";

    if (this.data.status === "queued") return "Message queued.";

    if (this.data.restored && this.data.kind === "send") return "Sent a message to";

    if (this.data.status === "done" && this.data.kind === "send") return "Agent answered.";

    if (this.data.kind === "load" && this.data.agentName === "agentless") return "Cleared active agent";

    if (this.data.kind === "load") return "Loaded";

    if (this.data.kind === "send") return "Sent a message to";

    return String(this.data.kind ?? "agents");
  }

  body(width: number) {
    if (this.data.phase === "call") return this.callLines();

    if (this.data.error) {
      const error = wrap(this.data.error, width).map((line) => this.red(line));
      return this.expanded && this.data.call ? [...error, "", ...this.callLines()] : error;
    }

    if (this.data.kind === "discoverSessions") return this.sessionTreeLines(width);

    if (this.data.kind === "load") return this.configurationLines(width);
    const content = wrap(this.bodyText(), width);
    const activityLines = this.activityLines(width);
    const callLines = this.expanded && this.data.call ? ["", ...this.callLines()] : [];

    return [...content, ...activityLines, ...callLines];
  }

  callLines() {
    const call = this.data.call ?? {};
    const parameters = isRecord(call.parameters) ? call.parameters : {};
    const effectiveParameters = isRecord(call.effectiveParameters) ? call.effectiveParameters : undefined;
    const identity = ["toolCallId", "callerEntryId"]
      .filter((key) => call[key] !== undefined)
      .map((key) => `${this.muted(`${key}:`)} ${formatValue(call[key])}`);
    const properties = Object.entries(parameters).map(
      ([key, value]) => `${this.muted(`${key}:`)} ${formatValue(value)}`,
    );
    const resolvedProperties = effectiveParameters
      ? Object.entries(effectiveParameters).filter(
          ([key, value]) => !(key in parameters) || !isDeepStrictEqual(parameters[key], value),
        )
      : [];
    const resolved =
      resolvedProperties.length > 0
        ? [
            "",
            this.bold("Resolved properties"),
            ...resolvedProperties.map(([key, value]) => `${this.muted(`${key}:`)} ${formatValue(value)}`),
          ]
        : [];

    return [this.bold("Call properties"), ...identity, ...properties, ...resolved];
  }

  bodyText() {
    return this.data.kind === "send" && this.data.status === "done"
      ? this.data.answer || this.data.message || ""
      : this.data.message || "";
  }

  sessionTreeLines(width: number) {
    const sessions = Array.isArray(this.data.sessions) ? this.data.sessions : [];
    const title = center(this.bold("Orchestration Tree"), width);

    if (sessions.length === 0)
      return [title, this.muted("─".repeat(width)), "", this.muted("No related sessions found.")];
    const end = Math.min(SESSION_TREE_VISIBLE_ITEMS, sessions.length);
    const scroll =
      sessions.length > SESSION_TREE_VISIBLE_ITEMS
        ? ["", this.muted(fit(`  Showing 1-${end} of ${sessions.length}`, width))]
        : [];

    return [
      title,
      this.muted("─".repeat(width)),
      "",
      ...sessions.slice(0, end).map((session) => this.sessionTreeLine(session, width)),
      ...scroll,
    ];
  }

  sessionTreeLine(session: UnknownRecord, width: number) {
    const connector = sessionTreeConnector(session);
    const indicator = session.running ? this.green("●") : this.dim("○");
    const agent =
      typeof session.agentName === "string" && session.agentName ? `${this.agentName(session.agentName)} ` : "";
    const message = sessionMessage(session);
    const id = this.dim(`(${visibleSessionId(session, this.data.sessions ?? [])})`);
    const left = `${this.dim(connector)}${indicator} ${agent}`;
    const inactive = session.running
      ? ` ${this.dim("Inactive:")} ${this.timer(formatDuration(Number(session.inactiveMs ?? 0)))}`
      : "";
    const right = `${id}${inactive}`;

    return joinWithMiddle(left, message, right, width);
  }

  configurationLines(width: number) {
    const configuration = this.data.configuration ?? {};
    const lines = Object.entries(configuration).map(([key, value]) => `${this.muted(`${key}:`)} ${formatValue(value)}`);

    if (this.expanded && this.data.systemPrompt) {
      lines.push(
        "",
        this.bold("Resolved system prompt"),
        ...wrap(formatSystemPromptForCard(this.data.systemPrompt), width),
      );
    }

    return lines.length ? lines : [this.muted("No configuration changes.")];
  }

  activityLines(width: number, maxLines = this.expanded ? MAX_CARD_ACTIVITY_LINES : 4) {
    const answer = normalizeInline(this.data.answer);
    const activities = Array.isArray(this.data.activities)
      ? this.data.activities.filter(
          (activity) => !(answer && activity?.type === "assistant" && normalizeInline(activity.text) === answer),
        )
      : [];

    if (activities.length === 0 || maxLines <= 0) return [];
    const activityCount = Math.max(activities.length, Number(this.data.activityCount ?? 0));
    const activityLimit = Math.max(0, maxLines - (activityCount > maxLines ? 1 : 0));
    const visible = activityLimit > 0 ? activities.slice(-activityLimit) : [];
    const hidden = activityCount - visible.length;
    const lines = hidden > 0 ? [this.muted(`├─ [+${hidden} activities]`)] : [];

    for (const activity of visible) {
      lines.push(fit(`${this.muted("├─")} ${formatActivity(activity)}`, width));
    }

    return lines;
  }

  footer(width: number) {
    const collapse = this.expanded ? "Ctrl+O to collapse" : "Ctrl+O to expand";
    const end = this.totalDurationText();

    return joinWithRight(this.muted(collapse), this.dim(end), width);
  }

  totalDurationText() {
    if (this.data.kind !== "send" || !this.data.startedAt) return "";
    const endAt = this.data.completedAt ?? this.data.updatedAt ?? this.data.startedAt;

    return formatDuration(Math.max(0, endAt - this.data.startedAt));
  }

  statusIcon() {
    if (this.data.kind === "load") return this.pink("→");

    if (this.data.status === "done") return this.green("✓");

    if (typeof this.data.status === "string" && ["error", "aborted", "stopped"].includes(this.data.status))
      return this.red("!");

    if (this.data.status === "queued") return this.pink("○");

    if (this.data.status === "running") return this.green("●");

    if (this.data.status === "restored") return this.muted("○");

    return this.muted("○");
  }

  colorBorder(text: string) {
    return this.theme.fg("dim", text);
  }

  bold(text: string) {
    return this.theme.bold(text);
  }

  muted(text: string) {
    return this.theme.fg("muted", text);
  }

  dim(text: string) {
    return this.theme.fg("dim", text);
  }

  green(text: string) {
    return this.theme.fg("success", text);
  }

  red(text: string) {
    return this.theme.fg("error", text);
  }

  purple(text: string) {
    return this.theme.fg("accent", text);
  }

  brightPurple(text: string) {
    return `\x1b[95m${text}\x1b[39m`;
  }

  pink(text: string) {
    return this.theme.fg("warning", text);
  }

  timer(text: string) {
    return this.brightPurple(text);
  }

  agent(text: string) {
    return this.theme.bold(styleAgentName(text));
  }

  agentName(text: string) {
    return this.theme.bold(styleAgentName(text, { bracketed: true }));
  }
}

function formatSystemPromptForCard(systemPrompt: unknown) {
  return String(systemPrompt ?? "")
    .replace("The following skills provide specialized instructions for specific tasks.", "Available skills")
    .replace(/<available_skills>\s*([\s\S]*?)\s*<\/available_skills>/g, (_full, body) =>
      String(body)
        .replace(/<skill>\s*([\s\S]*?)\s*<\/skill>/g, (_skill, skillBody) => {
          const name = xmlText(skillBody, "name");
          const description = xmlText(skillBody, "description");
          const location = xmlText(skillBody, "location");
          return [name ? `Skill: ${name}` : "", description, location ? `Path: ${location}` : ""]
            .filter(Boolean)
            .join("\n");
        })
        .replace(/<\/?(?:skill|name|description|location)[^>]*>/g, "")
        .trim(),
    )
    .replace(/\n{3,}/g, "\n\n");
}

function xmlText(text: string, tag: string) {
  return text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim();
}

function formatActivity(activity: unknown) {
  if (!isRecord(activity)) return normalizeInline(activity);

  if (activity.type === "tool")
    return normalizeInline(
      `[${activity.name}] ${activity.summary ?? ""} ${activity.status ? `(${activity.status})` : ""}`,
    );

  return normalizeInline(activity.text ?? activity.summary ?? JSON.stringify(activity));
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");

  if (value && typeof value === "object") return JSON.stringify(value);

  return String(value ?? "");
}
