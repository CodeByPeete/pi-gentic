import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UnknownRecord } from "../../shared/types.js";
import { isRecord } from "../../shared/value.js";

export function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleLength(text)) / 2));

  return fit(`${" ".repeat(padding)}${text}`, width);
}

export function renderBordered(
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

function visibleLength(text: unknown) {
  return visibleWidth(String(text ?? ""));
}
const AGENT_COLORS = [36, 92, 95, 93, 91, 94, 96, 33];

export function styleAgentName(agentName: unknown, { bracketed = false }: UnknownRecord = {}) {
  const text = bracketed ? `[${agentName}]` : agentName;

  return `\x1b[${agentColorCode(agentName)}m${text}\x1b[39m`;
}

function agentColorCode(agentName: unknown) {
  return AGENT_COLORS[hashString(String(agentName ?? "")) % AGENT_COLORS.length];
}

export function createAgentLabel(agentName: unknown) {
  return {
    invalidate() {},
    render(width: number) {
      return [rightAlign(styleAgentName(agentName), width)];
    },
  };
}

export function invisibleComponent() {
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
export function formatActivity(activity: unknown) {
  if (!isRecord(activity)) return normalizeInline(activity);

  if (activity.type === "tool")
    return normalizeInline(
      `[${activity.name}] ${activity.summary ?? ""} ${activity.status ? `(${activity.status})` : ""}`,
    );

  return normalizeInline(activity.text ?? activity.summary ?? JSON.stringify(activity));
}

export function formatValue(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");

  if (value && typeof value === "object") return JSON.stringify(value);

  return String(value ?? "");
}
