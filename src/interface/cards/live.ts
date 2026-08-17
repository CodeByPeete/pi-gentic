import { type Component, type TUI } from "@earendil-works/pi-tui";
import { Duration, Effect, Fiber, Schedule } from "effect";
import { recoverDiagnostic, reportRuntimeDiagnostic } from "../../shared/diagnostics.js";
import type { PiApi, PiContext, PiTheme } from "../../infrastructure/pi/types.js";
import type { ExtensionRuntime } from "../../runtime/ExtensionRuntime.js";
import type { UnknownRecord } from "../../shared/types.js";
import { formatDuration, isRecord, shortestUniqueSessionId } from "../../shared/value.js";
import { CARD_MESSAGE_TYPE, cardRuntime, isActiveCard, liveCardKey, normalizeCardDetails } from "./state.js";
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
} from "../presentation/text.js";

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
