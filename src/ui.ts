import {
  formatDuration,
  isRecord,
  shortestUniqueSessionId,
  shortSessionId,
} from "./catalog.js";

const COMPLETED_CARD_TTL_MS = 60_000;

const ACTIVE_CARD_STATUSES = new Set(["queued", "running"]);
const TERMINAL_CARD_STATUSES = new Set([
  "done",
  "error",
  "aborted",
  "stopped",
]);
const liveCards = new Map();
const persistedCards = new Map();
const liveCardRefreshers = new Set<(details?: AnyRecord) => void>();

export function isActiveCard(details) {
  return ACTIVE_CARD_STATUSES.has(details?.status);
}

export function isTerminalCard(details) {
  return TERMINAL_CARD_STATUSES.has(details?.status);
}

export function liveCardKey(details) {
  if (!details || typeof details !== "object") return undefined;

  return details.cardId ?? details.sessionId;
}

export function setLiveCardDetails(
  details: AnyRecord,
  options: AnyRecord = {},
) {
  const key = liveCardKey(details);

  if (!key) return undefined;
  const existing = liveCards.get(key);

  if (existing?.timer) clearTimeout(existing.timer);
  const nextDetails = { ...(existing?.details ?? {}), ...details };
  const ttlMs = liveCardTtl(nextDetails, options.ttlMs);
  const timer =
    ttlMs === undefined
      ? undefined
      : setTimeout(() => liveCards.delete(key), ttlMs);

  timer?.unref?.();

  liveCards.set(key, { details: nextDetails, timer });
  notifyLiveCardRefreshers(nextDetails);

  return nextDetails;
}

export function getLiveCardDetails(details) {
  const key = liveCardKey(details);

  return key ? liveCards.get(key)?.details : undefined;
}

export function setPersistedCardDetails(details) {
  const key = liveCardKey(details);

  if (!key) return undefined;
  const nextDetails = { ...(persistedCards.get(key) ?? {}), ...details };

  persistedCards.set(key, nextDetails);
  notifyLiveCardRefreshers(nextDetails);

  return nextDetails;
}

export function restorePersistedCardDetails(sessionManager) {
  const entries =
    sessionManager?.getBranch?.() ?? sessionManager?.getEntries?.() ?? [];

  for (const entry of entries) {
    if (entry?.customType !== CARD_STATE_ENTRY_TYPE) continue;
    if (!entry.data || typeof entry.data !== "object") continue;

    setPersistedCardDetails(entry.data);
  }
}

function getPersistedCardDetails(details) {
  const key = liveCardKey(details);

  return key ? persistedCards.get(key) : undefined;
}

function resolveCardDetails(details) {
  const persistedDetails = getPersistedCardDetails(details);
  const liveDetails = getLiveCardDetails(details);

  return {
    details: { ...details, ...(persistedDetails ?? {}), ...(liveDetails ?? {}) },
    persistedDetails,
    liveDetails,
    live: isActiveCard(liveDetails),
  };
}

export function clearLiveCardDetails(details) {
  const key = liveCardKey(details);
  const entry = key ? liveCards.get(key) : undefined;

  if (entry?.timer) clearTimeout(entry.timer);

  if (key) liveCards.delete(key);

  notifyLiveCardRefreshers(entry?.details ?? details);
}

function notifyLiveCardRefreshers(details?: AnyRecord) {
  for (const refresh of liveCardRefreshers) refresh(details);
}

function liveCardTtl(details, requestedTtl) {
  if (!details.completedAt && !isTerminalCard(details)) return undefined;

  return Math.max(100, Number(requestedTtl ?? COMPLETED_CARD_TTL_MS));
}

const COMBINING_MARK = /\p{Mark}/u;

const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

const REGIONAL_INDICATOR_START = 0x1f1e6;

const REGIONAL_INDICATOR_END = 0x1f1ff;

export function center(text, width) {
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
    ...content(innerWidth).map(
      (line) => colorBorder("│ ") + fit(line, innerWidth) + colorBorder(" │"),
    ),
    colorBorder(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
  ];
}

export function joinWithRight(left, right, width) {
  if (!right) return fit(left, width);
  const rightWidth = visibleLength(right);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  const fittedLeft = fit(left, leftWidth);

  return `${fittedLeft}${" ".repeat(Math.max(1, width - visibleLength(fittedLeft) - rightWidth))}${right}`;
}

export function joinWithMiddle(left, middle, right, width) {
  const rightWidth = visibleLength(right);
  const leftAreaWidth = Math.max(0, width - rightWidth - 1);
  const middleWidth = Math.max(0, leftAreaWidth - visibleLength(left));
  const fittedLeft =
    middleWidth > 0
      ? `${left}${fit(middle, middleWidth)}`
      : fit(left, leftAreaWidth);

  return `${fittedLeft}${" ".repeat(Math.max(1, width - visibleLength(fittedLeft) - rightWidth))}${right}`;
}

export function normalizeInline(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function wrap(text, width) {
  const clean = String(text ?? "");

  if (!clean) return [];
  const lines: string[] = [];

  for (const rawLine of clean.split(/\r?\n/)) {
    if (!rawLine) {
      lines.push("");
      continue;
    }

    let line = rawLine;

    while (line.length > 0) {
      const chunk = takeVisiblePrefix(line, width);

      if (!chunk.text || chunk.end >= line.length) {
        lines.push(line);
        break;
      }
      lines.push(chunk.text);
      line = line.slice(chunk.end);
    }
  }

  return lines;
}

export function fit(text, width) {
  if (width <= 0) return "";
  const value = String(text ?? "");
  const fitted = takeVisiblePrefix(value, width);

  if (fitted.end >= value.length)
    return value + " ".repeat(width - fitted.width);
  return `${takeVisiblePrefix(value, Math.max(0, width - 1), true).text}…`;
}

export function visibleLength(text) {
  const value = String(text ?? "");
  let width = 0;
  let index = 0;

  while (index < value.length) {
    const unit = readDisplayUnit(value, index, width);
    width += unit.width;
    index = unit.end;
  }

  return width;
}

function takeVisiblePrefix(text, maxWidth, closeAnsi = false) {
  const value = String(text ?? "");
  let output = "";
  let width = 0;
  let index = 0;
  let sawAnsi = false;

  while (index < value.length) {
    const unit = readDisplayUnit(value, index, width);

    if (unit.control) {
      output += value.slice(index, unit.end);
      sawAnsi = true;
      index = unit.end;
      continue;
    }

    if (width >= maxWidth || width + unit.width > maxWidth) break;
    output += value.slice(index, unit.end);
    width += unit.width;
    index = unit.end;
  }

  while (index < value.length) {
    const sequence = controlSequenceAt(value, index);

    if (!sequence) break;
    output += sequence;
    sawAnsi = true;
    index += sequence.length;
  }

  return {
    text: closeAnsi && sawAnsi ? `${output}\x1b[0m` : output,
    width,
    end: index,
  };
}

function readDisplayUnit(text, index, column) {
  const sequence = controlSequenceAt(text, index);

  if (sequence)
    return { end: index + sequence.length, width: 0, control: true };
  const codePoint = text.codePointAt(index);

  if (codePoint === undefined)
    return { end: index + 1, width: 0, control: false };
  let end = index + codePointSize(codePoint);

  if (codePoint === 9) return { end, width: 4 - (column % 4), control: false };

  if (isControlCodePoint(codePoint)) return { end, width: 0, control: false };

  if (isRegionalIndicator(codePoint)) {
    const next = text.codePointAt(end);

    if (next !== undefined && isRegionalIndicator(next))
      end += codePointSize(next);

    return { end, width: 2, control: false };
  }

  const keycapBase = isKeycapBase(codePoint);
  let width = baseDisplayWidth(codePoint, text.codePointAt(end));

  while (end < text.length) {
    const next = text.codePointAt(end);

    if (next === undefined) break;
    const nextSize = codePointSize(next);

    if (
      isVariationSelector(next) ||
      isCombiningCodePoint(next) ||
      isEmojiModifierCodePoint(next)
    ) {
      end += nextSize;
      continue;
    }

    if (keycapBase && next === 0x20e3) {
      end += nextSize;
      width = 2;
      continue;
    }

    if (next !== 0x200d) break;
    end += nextSize;
    const joined = text.codePointAt(end);

    if (joined === undefined) break;
    end += codePointSize(joined);
    width = 2;
  }

  return { end, width, control: false };
}

function controlSequenceAt(text, index) {
  if (text[index] !== "\x1b") return "";
  const rest = text.slice(index);

  return (
    rest.match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/)?.[0] ??
    rest.match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/)?.[0] ??
    ""
  );
}

function codePointSize(codePoint) {
  return codePoint > 0xffff ? 2 : 1;
}

function baseDisplayWidth(codePoint, nextCodePoint) {
  if (isTextVariationSelector(nextCodePoint)) return 1;

  if (isEmojiVariationSelector(nextCodePoint)) return 2;

  if (isWideCodePoint(codePoint)) return 2;

  if (isEmojiCodePoint(codePoint))
    return isEmojiPresentationCodePoint(codePoint) ? 2 : 1;
  return 1;
}

function isControlCodePoint(codePoint) {
  return (
    (codePoint >= 0 && codePoint < 0x20) ||
    (codePoint >= 0x7f && codePoint < 0xa0)
  );
}

function isCombiningCodePoint(codePoint) {
  return COMBINING_MARK.test(String.fromCodePoint(codePoint));
}

function isEmojiCodePoint(codePoint) {
  return EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(codePoint));
}

function isEmojiPresentationCodePoint(codePoint) {
  return EMOJI_PRESENTATION.test(String.fromCodePoint(codePoint));
}

function isTextVariationSelector(codePoint) {
  return codePoint === 0xfe0e;
}

function isEmojiVariationSelector(codePoint) {
  return codePoint === 0xfe0f;
}

function isEmojiModifierCodePoint(codePoint) {
  return EMOJI_MODIFIER.test(String.fromCodePoint(codePoint));
}

function isKeycapBase(codePoint) {
  return (
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    codePoint === 0x23 ||
    codePoint === 0x2a
  );
}

function isRegionalIndicator(codePoint) {
  return (
    codePoint >= REGIONAL_INDICATOR_START && codePoint <= REGIONAL_INDICATOR_END
  );
}

function isVariationSelector(codePoint) {
  return (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isWideCodePoint(codePoint) {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

export const AGENT_WIDGET_KEY = "pi-gentic-agent";

export const CARD_MESSAGE_TYPE = "pi-gentic:card";

export const CARD_STATE_ENTRY_TYPE = "pi-gentic:card-state";

export const LIVE_REFRESH_WIDGET_KEY = "pi-gentic-live-refresh";

const AGENT_COLORS = [36, 92, 95, 93, 91, 94, 96, 33];

export function setAgentLabel(ctx, agentName) {
  if (ctx.mode !== "tui" || typeof ctx.ui?.setWidget !== "function") return;
  const content = agentName ? () => createAgentLabel(agentName) : undefined;

  ctx.ui.setWidget(AGENT_WIDGET_KEY, content, { placement: "belowEditor" });
}

export function showCard(pi, text, details) {
  pi.sendMessage({
    customType: CARD_MESSAGE_TYPE,
    content: text,
    display: true,
    details,
  });
}

export function startLiveRefresh(
  ctx: PiContext,
  key = "default",
  options: AnyRecord = {},
) {
  const noop = (() => {}) as (() => void) & {
    refresh?: (details?: AnyRecord) => void;
  };

  noop.refresh = () => {};

  if (ctx.mode !== "tui" || typeof ctx.ui?.setWidget !== "function")
    return noop;
  const widgetKey = `${LIVE_REFRESH_WIDGET_KEY}:${key}`;
  const placement = options.placement ?? "aboveEditor";
  const resolveContext = () => options.resolveContext?.() ?? ctx;
  const minIntervalMs = Math.max(16, Number(options.intervalMs ?? 100));
  let stopped = false;
  let pending = false;
  let mountedContext: PiContext | undefined;
  let tui: AnyRecord | undefined;
  let lastRefreshAt = 0;
  let refreshTimer: NodeJS.Timeout | undefined;
  let pulseTimer: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  const clearRefreshTimer = () => {
    if (!refreshTimer) return;
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    liveCardRefreshers.delete(stop.refresh);
    clearRefreshTimer();

    if (pulseTimer) clearInterval(pulseTimer);
    if (timeout) clearTimeout(timeout);

    try {
      mountedContext?.ui?.setWidget?.(widgetKey, undefined, { placement });
    } catch {
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
        (nextTui, theme) => {
          tui = nextTui;

          return (
            options.createComponent?.(nextTui, theme) ?? invisibleComponent()
          );
        },
        { placement },
      );
    } catch {
      if (resolveContext() === ctx) stop();
    }
  };

  stop.refresh = (details?: AnyRecord) => {
    if (stopped || pending || options.acceptsDetails?.(details) === false)
      return;
    const delay = Math.max(0, minIntervalMs - (Date.now() - lastRefreshAt));
    pending = true;
    refreshTimer = setTimeout(renderPulse, delay);
    refreshTimer.unref?.();
  };

  if (options.trackLiveCards !== false) liveCardRefreshers.add(stop.refresh);

  if (options.autoPulse !== false) {
    pulseTimer = setInterval(() => {
      if (options.shouldPulse?.() === false) return;
      renderPulse();
    }, Math.max(250, Number(options.pulseIntervalMs ?? 1000)));
    pulseTimer.unref?.();
  }

  if (options.ttlMs !== undefined) {
    timeout = setTimeout(
      () => stop(),
      Math.max(1000, Number(options.ttlMs)),
    );
    timeout.unref?.();
  }

  return stop;
}

export function startSessionLiveCardRefresh(ctx: PiContext) {
  const stop = startLiveRefresh(ctx, "session-live-cards", {
    acceptsDetails: (details) =>
      !details || cardBelongsToSession(ctx, details),
    createComponent: (tui, theme) => new LiveCardsPanel(ctx, tui, theme),
    shouldPulse: () => sessionLiveCardDetails(ctx).length > 0,
  });

  stop.refresh?.();

  return stop;
}

export function sessionHasVisibleLiveCard(ctx: PiContext) {
  return sessionLiveCardDetails(ctx).length > 0;
}

function sessionLiveCardDetails(ctx: PiContext) {
  const cards = [...liveCards.values()]
    .map((entry) => entry.details)
    .filter(
      (details) => isActiveCard(details) && cardBelongsToSession(ctx, details),
    )
    .sort(
      (left, right) =>
        Number(left.startedAt ?? left.updatedAt ?? 0) -
        Number(right.startedAt ?? right.updatedAt ?? 0),
    );

  return [
    ...new Map(
      cards.map((details) => [details.sessionId ?? liveCardKey(details), details]),
    ).values(),
  ];
}

function cardBelongsToSession(ctx: PiContext, details: AnyRecord) {
  const sessionId = currentSessionId(ctx);

  if (details?.callerSessionId)
    return details.callerSessionId === sessionId;
  const key = liveCardKey(details);

  return Boolean(key && sessionCardKeys(ctx).has(key));
}

function currentSessionId(ctx: PiContext) {
  try {
    return ctx.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

function sessionCardKeys(ctx: PiContext) {
  const keys = new Set();
  let entries: AnyRecord[] = [];

  try {
    entries = [
      ...(ctx.sessionManager?.getEntries?.() ?? []),
      ...(ctx.sessionManager?.getBranch?.() ?? []),
    ];
  } catch {
    return keys;
  }

  for (const entry of entries) {
    const details =
      entry?.type === "custom_message" &&
      entry.customType === CARD_MESSAGE_TYPE &&
      entry.display !== false
        ? entry.details
        : entry?.type === "message" &&
            entry.message?.role === "toolResult" &&
            entry.message?.toolName === "agents"
          ? entry.message.details
          : undefined;
    const key = liveCardKey(details);

    if (key) keys.add(key);
  }

  return keys;
}

class LiveCardsPanel {
  ctx: PiContext;
  tui: AnyRecord;
  theme: PiTheme;

  constructor(ctx: PiContext, tui: AnyRecord, theme: PiTheme) {
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
    const hiddenCount = Math.max(0, cards.length - rowLimit);
    const visibleCards = cards.slice(-rowLimit);
    const rows = visibleCards.map((details) =>
      this.cardRow(details, Math.max(10, width - 4)),
    );

    if (hiddenCount > 0)
      rows[0] = this.dim(
        `… ${hiddenCount} earlier active card${hiddenCount === 1 ? "" : "s"}`,
      );

    return renderBordered(
      width,
      (text) => this.dim(text),
      () => rows,
    );
  }

  cardRow(details: AnyRecord, width: number) {
    const queued = details.status === "queued";
    const indicator = queued ? this.accent("○") : this.success("●");
    const mode = this.accent(details.async ? "[ASYNC]" : "[SYNC]");
    const agent =
      details.agentName && details.agentName !== "agentless"
        ? styleAgentName(details.agentName)
        : this.bold("agent");
    const session = details.sessionId
      ? this.dim(`(${shortSessionId(details.sessionId)})`)
      : "";
    const activities = Array.isArray(details.activities)
      ? details.activities
      : [];
    const detail = normalizeInline(
      activities.length > 0
        ? formatActivity(activities.at(-1))
        : queued
          ? `Queued: ${details.message ?? ""}`
          : details.message,
    );
    const now = Date.now();
    const inactive = formatDuration(
      Math.max(0, now - Number(details.updatedAt ?? now)),
    );
    const total = formatDuration(
      Math.max(0, now - Number(details.startedAt ?? now)),
    );
    const left = `${indicator} ${mode} ${agent}${session ? ` ${session}` : ""}`;
    const middle = ` ${this.dim("│")} ${detail}`;
    const right =
      `${this.dim("idle")} ${this.timer(inactive)} ` +
      `${this.dim("· total")} ${this.timer(total)}`;

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

export function styleAgentName(
  agentName: unknown,
  { bracketed = false }: AnyRecord = {},
) {
  const text = bracketed ? `[${agentName}]` : agentName;

  return `\x1b[${agentColorCode(agentName)}m${text}\x1b[39m`;
}

export function agentColorCode(agentName) {
  return AGENT_COLORS[
    hashString(String(agentName ?? "")) % AGENT_COLORS.length
  ];
}

function createAgentLabel(agentName) {
  return {
    invalidate() {},
    render(width) {
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

function rightAlign(text, width) {
  return `${" ".repeat(Math.max(0, width - ansiVisibleLength(text)))}${text}`;
}

function ansiVisibleLength(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function hashString(text) {
  let hash = 0;

  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;

  return hash;
}

export const SESSION_TREE_VISIBLE_ITEMS = 12;

function sessionTreeConnector(session: AnyRecord) {
  const depth = Math.max(0, Number(session.depth ?? 0));

  return depth === 0
    ? ""
    : `${"│  ".repeat(Math.max(0, depth - 1))}${session.isLast === true ? "└─" : "├─"} `;
}

function sessionMessage(session: AnyRecord) {
  return normalizeInline(
    session.lastMessage ??
      session.firstMessage ??
      session.name ??
      "Untitled session",
  );
}

function visibleSessionId(session: AnyRecord, sessions: AnyRecord[]) {
  return shortestUniqueSessionId(
    session.sessionId ?? session.id,
    sessions.map((item) => item.sessionId ?? item.id),
  );
}

export function renderAgentsCall() {
  return new InvisibleComponent();
}

export function renderAgentsResult(
  result: AnyRecord,
  options: AnyRecord,
  theme: PiTheme,
  context: AnyRecord,
) {
  const previous = context.lastComponent;
  const previousCard = previous instanceof AgentsCard ? previous : undefined;
  const card = previousCard ?? new AgentsCard(theme);
  const originalDetails =
    result.details && typeof result.details === "object" ? result.details : {};
  const { details, liveDetails, live } = resolveCardDetails(originalDetails);

  if (isActiveCard(originalDetails) && details.livePanel === true)
    return new InvisibleComponent();
  const restoredRunning =
    details.status === "running" && !options.isPartial && !liveDetails;

  card.update(
    {
      cardId: details.cardId,
      kind: details.kind ?? context.args.action ?? "agents",
      live,
      restored: restoredRunning,
      status: restoredRunning
        ? "restored"
        : options.isPartial
          ? (details.status ?? "running")
          : (details.status ?? (context.isError ? "error" : "done")),
      async: details.async ?? context.args.async === true,
      agentName: details.agentName ?? context.args.agent,
      sessionId: details.sessionId ?? context.args.sessionId,
      message:
        details.message ?? context.args.message ?? firstText(result.content),
      activities: details.activities ?? [],
      startedAt:
        details.startedAt ??
        previousCard?.data?.startedAt ??
        (details.kind === "send" && details.status === "running"
          ? Date.now()
          : undefined),
      updatedAt: details.updatedAt ?? previousCard?.data?.updatedAt,
      completedAt: restoredRunning
        ? (details.completedAt ?? details.updatedAt ?? details.startedAt)
        : details.completedAt,
      error: details.error,
      configuration: details.configuration,
      sessions: details.sessions ?? details.configuration?.sessions,
      systemPrompt: details.systemPrompt,
    },
    options.expanded,
  );

  return card;
}

function firstText(content: unknown) {
  return Array.isArray(content)
    ? content.find((item) => item.type === "text")?.text
    : undefined;
}

class InvisibleComponent {
  invalidate() {}

  render() {
    return [];
  }
}

class AgentsCard {
  theme: PiTheme;
  data: AnyRecord;
  expanded: boolean;

  constructor(theme) {
    this.theme = theme;
    this.data = {};
    this.expanded = false;
  }

  update(data: AnyRecord, expanded: boolean) {
    this.data = data;
    this.expanded = expanded;
  }

  invalidate() {}

  render(width: number) {
    const { details, liveDetails, persistedDetails, live } =
      resolveCardDetails(this.data);
    const staleRunning = details.status === "running" && !live;
    this.data = {
      ...details,
      live,
      restored: staleRunning
        ? true
        : liveDetails || persistedDetails
          ? false
          : details.restored,
      status: staleRunning ? "restored" : details.status,
      completedAt: staleRunning
        ? (details.completedAt ?? details.updatedAt ?? details.startedAt)
        : details.completedAt,
    };
    return renderBordered(
      width,
      (text) => this.colorBorder(text),
      (innerWidth) => this.buildLines(innerWidth),
    );
  }

  buildLines(width: number) {
    const header = this.header(width);
    const maxBodyLines = 11;
    const body = this.expanded
      ? this.body(width).flatMap((line) => wrap(line, width))
      : this.collapsedBody(width, maxBodyLines);
    const footer = this.footer(width);
    const visibleBody =
      !this.expanded && body.length > maxBodyLines
        ? [
            ...body.slice(0, maxBodyLines - 1),
            this.muted(`… ${body.length - maxBodyLines + 1} more`),
          ]
        : body;

    return [header, "", ...visibleBody, "", footer];
  }

  header(width: number) {
    const icon = this.statusIcon();
    const async = this.data.async ? `${this.purple("[ASYNC]")} ` : "";
    const title = this.title();
    const agent =
      this.data.agentName && this.data.agentName !== "agentless"
        ? ` ${this.agent(this.data.agentName)}`
        : "";
    const session = this.data.sessionId
      ? ` ${this.dim(`(${shortSessionId(this.data.sessionId)})`)}`
      : "";
    const inactive =
      this.data.live && this.data.status === "running" && this.data.updatedAt
        ? `${this.dim("Inactive:")} ${this.timer(formatDuration(Date.now() - this.data.updatedAt))}`
        : "";

    return joinWithRight(
      `${icon} ${async}${this.bold(title)}${agent}${session}`,
      inactive,
      width,
    );
  }

  title() {
    if (this.data.status === "error") return "Agent call failed.";

    if (this.data.status === "stopped")
      return "Agent stopped before answering.";

    if (this.data.status === "aborted") return "Agent got aborted.";

    if (this.data.status === "queued") return "Message queued.";

    if (this.data.restored && this.data.kind === "send")
      return "Sent a message to";

    if (this.data.status === "done" && this.data.kind === "send")
      return "Agent answered.";

    if (this.data.kind === "load" && this.data.agentName === "agentless")
      return "Cleared active agent";

    if (this.data.kind === "load") return "Loaded";

    if (this.data.kind === "send") return "Sent a message to";

    return String(this.data.kind ?? "agents");
  }

  body(width: number) {
    if (this.data.error)
      return wrap(this.data.error, width).map((line) => this.red(line));

    if (this.data.kind === "discoverSessions")
      return this.sessionTreeLines(width);

    if (this.data.kind === "load") return this.configurationLines(width);
    const message = wrap(this.data.message || "", width);
    const activityLines = this.activityLines(width);

    return [...message, ...activityLines];
  }

  collapsedBody(width: number, maxLines: number) {
    if (this.data.kind !== "send" || this.data.error) return this.body(width);
    const message = wrap(this.data.message || "", width).slice(0, 2);
    const activities = this.activityLines(
      width,
      Math.max(0, maxLines - message.length),
    );

    return [...message, ...activities];
  }

  sessionTreeLines(width: number) {
    const sessions = Array.isArray(this.data.sessions)
      ? this.data.sessions
      : [];
    const title = center(this.bold("Orchestration Tree"), width);

    if (sessions.length === 0)
      return [
        title,
        this.muted("─".repeat(width)),
        "",
        this.muted("No related sessions found."),
      ];
    const end = Math.min(SESSION_TREE_VISIBLE_ITEMS, sessions.length);
    const scroll =
      sessions.length > SESSION_TREE_VISIBLE_ITEMS
        ? [
            "",
            this.muted(fit(`  Showing 1-${end} of ${sessions.length}`, width)),
          ]
        : [];

    return [
      title,
      this.muted("─".repeat(width)),
      "",
      ...sessions
        .slice(0, end)
        .map((session) => this.sessionTreeLine(session, width)),
      ...scroll,
    ];
  }

  sessionTreeLine(session: AnyRecord, width: number) {
    const connector = sessionTreeConnector(session);
    const indicator = session.running ? this.green("●") : this.dim("○");
    const agent = session.agentName
      ? `${this.agentName(session.agentName)} `
      : "";
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
    const lines = Object.entries(configuration).map(
      ([key, value]) => `${this.muted(`${key}:`)} ${formatValue(value)}`,
    );

    if (this.expanded && this.data.systemPrompt) {
      lines.push(
        "",
        this.bold("Resolved system prompt"),
        ...wrap(formatSystemPromptForCard(this.data.systemPrompt), width),
      );
    }

    return lines.length ? lines : [this.muted("No configuration changes.")];
  }

  activityLines(width: number, maxLines = this.expanded ? 14 : 4) {
    const activities = Array.isArray(this.data.activities)
      ? this.data.activities
      : [];

    if (activities.length === 0 || maxLines <= 0) return [];
    const activityLimit = Math.max(
      0,
      maxLines - (activities.length > maxLines ? 1 : 0),
    );
    const visible =
      activityLimit > 0 ? activities.slice(-activityLimit) : [];
    const hidden = activities.length - visible.length;
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
    const endAt =
      this.data.completedAt ??
      (this.data.live && isActiveCard(this.data)
        ? Date.now()
        : (this.data.updatedAt ?? this.data.startedAt));

    return formatDuration(Math.max(0, endAt - this.data.startedAt));
  }

  statusIcon() {
    if (this.data.kind === "load") return this.pink("→");

    if (this.data.status === "done") return this.green("✓");

    if (["error", "aborted", "stopped"].includes(this.data.status))
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
    .replace(
      "The following skills provide specialized instructions for specific tasks.",
      "Available skills",
    )
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

  return normalizeInline(
    activity.text ?? activity.summary ?? JSON.stringify(activity),
  );
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");

  if (value && typeof value === "object") return JSON.stringify(value);

  return String(value ?? "");
}
