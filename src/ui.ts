/**
 * Terminal UI rendering for pi-gentic.
 *
 * Cards and tree pickers render in plain terminal cells, so width calculations
 * must account for ANSI colors, emoji, combining marks, and wide characters.
 */
import { formatDuration, isRecord, shortSessionId } from "./core.js";

const RUNNING_CARD_TTL_MS = 10 * 60_000;

const COMPLETED_CARD_TTL_MS = 60_000;

const liveCards = new Map();

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
  const ttlMs = Math.max(100, Number(options.ttlMs ?? defaultTtl(nextDetails)));
  const timer = setTimeout(() => liveCards.delete(key), ttlMs);

  timer.unref?.();

  liveCards.set(key, { details: nextDetails, timer });

  return nextDetails;
}

export function getLiveCardDetails(details) {
  const key = liveCardKey(details);

  return key ? liveCards.get(key)?.details : undefined;
}

export function clearLiveCardDetails(details) {
  const key = liveCardKey(details);
  const entry = key ? liveCards.get(key) : undefined;

  if (entry?.timer) clearTimeout(entry.timer);

  if (key) liveCards.delete(key);
}

function defaultTtl(details) {
  return details.completedAt ||
    ["done", "error", "aborted", "stopped"].includes(details.status)
    ? COMPLETED_CARD_TTL_MS
    : RUNNING_CARD_TTL_MS;
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
  const lines = [];

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

/** Measures terminal cell width after stripping ANSI control sequences. */
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
  const noop = (() => {}) as (() => void) & { refresh?: () => void };

  noop.refresh = () => {};

  if (ctx.mode !== "tui" || typeof ctx.ui?.setWidget !== "function")
    return noop;
  const widgetKey = `${LIVE_REFRESH_WIDGET_KEY}:${key}`;
  const minIntervalMs = Math.max(16, Number(options.intervalMs ?? 100));
  let stopped = false;
  let pending = false;
  let lastRefreshAt = 0;
  let refreshTimer: NodeJS.Timeout | undefined;
  let pulseTimer: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  const clearRefreshTimer = () => {
    if (!refreshTimer) return;
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };
  const clearPulseTimer = () => {
    if (!pulseTimer) return;
    clearInterval(pulseTimer);
    pulseTimer = undefined;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearRefreshTimer();
    clearPulseTimer();

    if (timeout) clearTimeout(timeout);

    try {
      ctx.ui.setWidget(widgetKey, undefined, { placement: "belowEditor" });
    } catch {
      // Stale command contexts are expected after session switches.
    }
  };
  const renderPulse = () => {
    pending = false;

    if (stopped) return;

    try {
      lastRefreshAt = Date.now();
      ctx.ui.setWidget(widgetKey, () => invisibleComponent(), {
        placement: "belowEditor",
      });
    } catch {
      stop();
    }
  };

  stop.refresh = () => {
    if (stopped || pending) return;
    const delay = Math.max(0, minIntervalMs - (Date.now() - lastRefreshAt));
    pending = true;
    refreshTimer = setTimeout(renderPulse, delay);
    refreshTimer.unref?.();
  };

  if (options.autoPulse !== false) {
    pulseTimer = setInterval(
      renderPulse,
      Math.max(250, Number(options.pulseIntervalMs ?? 1000)),
    );
    pulseTimer.unref?.();
  }

  timeout = setTimeout(
    () => stop(),
    Math.max(1000, Number(options.ttlMs ?? 10 * 60_000)),
  );

  timeout.unref?.();

  return stop;
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

export function renderSessionTree(details: AnyRecord, theme: PiTheme) {
  return new SessionTreeCard(details.sessions ?? [], theme);
}

export function createSessionTreePicker(
  sessions: AnyRecord[],
  theme: PiTheme,

  done: (session: AnyRecord | undefined) => void,

  requestRender = () => {},
  options: AnyRecord = {},
) {
  return new SessionTreeCard(sessions, theme, {
    ...options,
    onSelect: done,
    requestRender,
  });
}

/** Interactive orchestration tree used by the orchestration-tree picker. */
export class SessionTreeCard {
  sessions: AnyRecord[];
  theme: PiTheme;
  selectedIndex: number;
  maxVisible: number;

  onSelect?: (session: AnyRecord | undefined) => void;

  requestRender: () => void;

  refreshSessions?: () => Promise<AnyRecord[]> | AnyRecord[];
  refreshing: boolean;
  refreshIntervalMs: number;
  repaintIntervalMs: number;
  refreshTimer?: NodeJS.Timeout;
  repaintTimer?: NodeJS.Timeout;

  constructor(sessions: AnyRecord[], theme: PiTheme, options: AnyRecord = {}) {
    this.sessions = sessions;
    this.theme = theme;
    this.selectedIndex = 0;
    this.maxVisible = Math.max(
      1,
      Number(options.maxVisible ?? SESSION_TREE_VISIBLE_ITEMS),
    );
    this.onSelect =
      typeof options.onSelect === "function"
        ? (options.onSelect as (session: AnyRecord | undefined) => void)
        : undefined;
    this.requestRender =
      typeof options.requestRender === "function"
        ? (options.requestRender as () => void)
        : () => {};
    this.refreshSessions =
      typeof options.refreshSessions === "function"
        ? (options.refreshSessions as () => Promise<AnyRecord[]> | AnyRecord[])
        : undefined;
    this.refreshing = false;
    this.refreshIntervalMs = Math.max(
      1000,
      Number(options.refreshIntervalMs ?? 5000),
    );
    this.repaintIntervalMs = Math.max(
      250,
      Number(options.repaintIntervalMs ?? 1000),
    );
    this.ensureRefreshTimer();
  }

  invalidate() {}

  dispose() {
    this.clearRefreshTimer();
  }

  updateSessions(sessions: AnyRecord[]) {
    const selected = this.sessions[this.clampedSelectedIndex()];
    this.sessions = sessions ?? [];
    const selectedIndex = selected
      ? this.sessions.findIndex((session) => sameSession(session, selected))
      : -1;
    this.selectedIndex =
      selectedIndex >= 0 ? selectedIndex : this.clampedSelectedIndex();
    this.ensureRefreshTimer();
  }

  async refresh() {
    if (!this.refreshSessions || this.refreshing) {
      this.requestRender();
      return;
    }
    this.refreshing = true;

    try {
      const sessions = await this.refreshSessions();

      if (Array.isArray(sessions)) this.updateSessions(sessions);
    } catch {
      this.ensureRefreshTimer();
    } finally {
      this.refreshing = false;
      this.requestRender();
    }
  }

  ensureRefreshTimer() {
    if (!this.sessions.some((session) => session.running)) {
      this.clearRefreshTimer();
      return;
    }

    if (!this.repaintTimer) {
      this.repaintTimer = setInterval(
        () => this.requestRender(),
        this.repaintIntervalMs,
      );
      this.repaintTimer.unref?.();
    }

    if (this.refreshTimer || !this.refreshSessions) return;
    this.refreshTimer = setInterval(
      () => void this.refresh(),
      this.refreshIntervalMs,
    );
    this.refreshTimer.unref?.();
  }

  clearRefreshTimer() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.repaintTimer) clearInterval(this.repaintTimer);
    this.refreshTimer = undefined;
    this.repaintTimer = undefined;
  }

  handleInput(data: string) {
    if (!this.onSelect) return;

    if (data === "\x1b") {
      this.onSelect(undefined);
      return;
    }

    if (data === "\r" || data === "\n") {
      this.onSelect(this.sessions[this.clampedSelectedIndex()]);
      return;
    }

    const lastIndex = Math.max(0, this.sessions.length - 1);

    if (data === "\x1b[A")
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    else if (data === "\x1b[B")
      this.selectedIndex = Math.min(lastIndex, this.selectedIndex + 1);
    else if (data === "\x1b[5~")
      this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
    else if (data === "\x1b[6~")
      this.selectedIndex = Math.min(
        lastIndex,
        this.selectedIndex + this.maxVisible,
      );
    else if (data === "\x1b[H" || data === "\x1b[1~") this.selectedIndex = 0;
    else if (data === "\x1b[F" || data === "\x1b[4~")
      this.selectedIndex = lastIndex;
    else return;
    this.requestRender();
  }

  render(width: number) {
    const innerWidth = Math.max(10, width - 4);
    const lines = this.lines(innerWidth);

    return [
      this.colorBorder(`╭${"─".repeat(Math.max(0, width - 2))}╮`),
      ...lines.map(
        (line) =>
          this.colorBorder("│ ") +
          fit(line, innerWidth) +
          this.colorBorder(" │"),
      ),
      this.colorBorder(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ];
  }

  lines(width: number) {
    if (this.sessions.length === 0) {
      return [
        center(this.bold("Orchestration Tree"), width),
        this.muted("─".repeat(width)),
        "",
        this.muted("No related sessions found."),
      ];
    }

    const { start, end } = this.visibleRange();
    const visible = this.sessions.slice(start, end);

    return [
      center(this.bold("Orchestration Tree"), width),
      this.muted("─".repeat(width)),
      "",
      ...visible.map((session, index) =>
        this.sessionLine(session, start + index, width),
      ),
      ...this.scrollLines(start, end, width),
    ];
  }

  visibleRange() {
    const selectedIndex = this.clampedSelectedIndex();
    const start = Math.max(
      0,
      Math.min(
        selectedIndex - Math.floor(this.maxVisible / 2),
        this.sessions.length - this.maxVisible,
      ),
    );

    return {
      start,
      end: Math.min(start + this.maxVisible, this.sessions.length),
    };
  }

  scrollLines(start: number, end: number, width: number) {
    if (this.sessions.length <= this.maxVisible) return [];
    const text = this.onSelect
      ? `  (${this.clampedSelectedIndex() + 1}/${this.sessions.length})`
      : `  Showing ${start + 1}-${end} of ${this.sessions.length}`;

    return [this.muted(""), this.muted(fit(text, width))];
  }

  clampedSelectedIndex() {
    return Math.min(
      Math.max(0, this.selectedIndex),
      Math.max(0, this.sessions.length - 1),
    );
  }

  sessionLine(session: AnyRecord, index: number, width: number) {
    const depth = Math.max(0, Number(session.depth ?? 0));
    const isLast = session.isLast === true;
    const connector =
      depth === 0
        ? ""
        : `${"│  ".repeat(Math.max(0, depth - 1))}${isLast ? "└─" : "├─"} `;
    const indicator = session.running ? this.green("●") : this.dim("○");
    const agent = session.agentName
      ? `${this.agentName(session.agentName)} `
      : "";
    const message = normalizeInline(
      session.lastMessage ??
        session.firstMessage ??
        session.name ??
        "Untitled session",
    );
    const id = this.dim(`(${shortSessionId(session.sessionId ?? session.id)})`);
    const isSelected = this.onSelect && index === this.clampedSelectedIndex();
    const selectMarker = this.onSelect
      ? isSelected
        ? `${this.green(">")} `
        : "  "
      : "";
    const left = `${selectMarker}${this.dim(connector)}${indicator} ${agent}`;
    const timerText = formatDuration(sessionInactiveMs(session));
    const inactive = session.running
      ? ` ${this.dim("Inactive:")} ${this.timer(timerText)}${" ".repeat(Math.max(0, 8 - timerText.length))}`
      : "";
    const right = `${id}${inactive}`;
    const line = joinWithMiddle(left, message, right, width);

    return isSelected ? this.selected(line) : line;
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

  timer(text: string) {
    return `\x1b[95m${text}\x1b[39m`;
  }

  selected(text: string) {
    return `\x1b[48;5;236m${text}\x1b[49m`;
  }

  agentName(text: string) {
    return this.theme.bold(styleAgentName(text, { bracketed: true }));
  }
}

export function sessionInactiveMs(session: AnyRecord) {
  if (!session.running) return Number(session.inactiveMs ?? 0);
  const timestamp = session.lastActivityAt ?? session.modified ?? 0;
  const time = new Date(
    typeof timestamp === "string" ||
      typeof timestamp === "number" ||
      timestamp instanceof Date
      ? timestamp
      : 0,
  ).getTime();

  return Number.isFinite(time) && time > 0
    ? Date.now() - time
    : Number(session.inactiveMs ?? 0);
}

function sameSession(a: AnyRecord, b: AnyRecord) {
  return Boolean(
    (a.sessionId && a.sessionId === b.sessionId) ||
      (a.id && a.id === b.id) ||
      (a.path && a.path === b.path),
  );
}

export function renderAgentsCall() {
  return new InvisibleComponent();
}

/** Reuses card instances during streaming updates so live details stay smooth. */
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
  const liveDetails = getLiveCardDetails(originalDetails);
  const details = { ...originalDetails, ...(liveDetails ?? {}) };
  const restoredRunning =
    details.status === "running" && !options.isPartial && !liveDetails;

  card.update(
    {
      cardId: details.cardId,
      kind: details.kind ?? context.args.action ?? "agents",
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

/** Chat card renderer for load, send, status, discovery, and error results. */
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
    const liveDetails = getLiveCardDetails(this.data);
    this.data = {
      ...this.data,
      ...(liveDetails ?? {}),
      restored: liveDetails ? false : this.data.restored,
    };
    const innerWidth = Math.max(10, width - 4);
    const lines = this.buildLines(innerWidth);

    return [
      this.colorBorder(`╭${"─".repeat(Math.max(0, width - 2))}╮`),
      ...lines.map(
        (line) =>
          this.colorBorder("│ ") +
          fit(line, innerWidth) +
          this.colorBorder(" │"),
      ),
      this.colorBorder(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ];
  }

  buildLines(width: number) {
    const header = this.header(width);
    const body = this.expanded
      ? this.body(width).flatMap((line) => wrap(line, width))
      : this.body(width);
    const footer = this.footer(width);
    const maxBodyLines = Math.max(1, 13 - 2);
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
      this.data.status === "running" && this.data.updatedAt
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
        .map((session, index) => this.sessionTreeLine(session, index, width)),
      ...scroll,
    ];
  }

  sessionTreeLine(session: AnyRecord, index: number, width: number) {
    const depth = Math.max(0, Number(session.depth ?? 0));
    const isLast = session.isLast === true;
    const connector =
      depth === 0
        ? ""
        : `${"│  ".repeat(Math.max(0, depth - 1))}${isLast ? "└─" : "├─"} `;
    const indicator = session.running ? this.green("●") : this.dim("○");
    const agent = session.agentName
      ? `${this.agentName(session.agentName)} `
      : "";
    const message = this.sessionMessage(session);
    const id = this.dim(`(${shortSessionId(session.sessionId ?? session.id)})`);
    const left = `${this.dim(connector)}${indicator} ${agent}`;
    const inactive = session.running
      ? ` ${this.dim("Inactive:")} ${this.timer(formatDuration(sessionInactiveMs(session)))}`
      : "";
    const right = `${id}${inactive}`;

    return joinWithMiddle(left, message, right, width);
  }

  sessionMessage(session: AnyRecord) {
    const text =
      session.lastMessage ??
      session.firstMessage ??
      session.name ??
      "Untitled session";

    return normalizeInline(text);
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
        ...wrap(this.data.systemPrompt, width),
      );
    }

    return lines.length ? lines : [this.muted("No configuration changes.")];
  }

  activityLines(width: number) {
    const activities = Array.isArray(this.data.activities)
      ? this.data.activities
      : [];

    if (activities.length === 0) return [];
    const visible = this.expanded
      ? activities.slice(-13)
      : activities.slice(-3);
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
      (this.data.status === "running"
        ? Date.now()
        : (this.data.updatedAt ?? this.data.startedAt));

    return formatDuration(Math.max(0, endAt - this.data.startedAt));
  }

  statusIcon() {
    if (this.data.status === "done") return this.green("✓");

    if (["error", "aborted", "stopped"].includes(this.data.status))
      return this.red("!");

    if (this.data.status === "queued") return this.pink("○");

    if (this.data.status === "running") return this.green("●");

    if (this.data.status === "restored") return this.muted("○");

    if (this.data.kind === "load") return this.pink("→");

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
