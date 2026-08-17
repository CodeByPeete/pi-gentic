import { isDeepStrictEqual } from "node:util";
import type { PiTheme } from "../../infrastructure/pi/types.js";
import type { UnknownRecord } from "../../shared/types.js";
import { formatDuration, isRecord, shortestUniqueSessionId, shortSessionId } from "../../shared/value.js";
import { isActiveCard, normalizeCardDetails, resolveCardDetails, stringField, type CardDetails } from "./state.js";
import {
  center,
  fit,
  formatActivity,
  formatValue,
  joinWithMiddle,
  joinWithRight,
  normalizeInline,
  renderBordered,
  styleAgentName,
  wrap,
} from "../presentation/text.js";

const MAX_CARD_ACTIVITY_LINES = 14;

const SESSION_TREE_VISIBLE_ITEMS = 12;

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
