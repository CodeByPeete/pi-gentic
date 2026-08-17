import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startSessionLiveCardRefresh } from "../dist/interface/cards/live.js";
import { renderAgentsResult } from "../dist/interface/cards/render.js";
import { clearLiveCardDetails, setLiveCardDetails } from "../dist/interface/cards/state.js";
import { createExtensionRuntime } from "../dist/runtime/ExtensionRuntime.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(root, "output");
const width = Number(process.env.PI_GENTIC_UI_CAPTURE_WIDTH ?? 120);
mkdirSync(outputDir, { recursive: true });

const theme = {
  bold: (text) => `\x1b[1m${text}\x1b[22m`,

  fg: (name, text) => `\x1b[${color(name)}m${text}\x1b[39m`,
};

const cases = [
  {
    name: "send-message-fg",
    details: {
      kind: "send",
      status: "running",
      async: false,
      agentName: "researcher",
      sessionId: "2f91a8c4-demo",
      message: "Investigate the skills config name resolution in pi-gentic...",
      startedAt: Date.now() - 649_000,
      updatedAt: Date.now() - 12_000,
      activities: [
        { text: "[+2 generations]" },
        { text: "Summarized package-manager filter behavior and edge cases" },
        { type: "tool", name: "read", summary: "docs/settings.md" },
        { type: "tool", name: "write", summary: "notes/skills-behavior.md" },
        {
          type: "tool",
          name: "bash",
          summary: 'rg "sessionName|session_info" -n',
        },
      ],
    },
  },
  {
    name: "send-message-bg",
    details: {
      kind: "send",
      status: "running",
      async: true,
      agentName: "researcher",
      sessionId: "2f91a8c4-demo",
      message: "Investigate the skills config name resolution in pi-gentic...",
      startedAt: Date.now() - 649_000,
      updatedAt: Date.now() - 649_000,
      activities: [
        { text: "[+2 generations]" },
        { text: "Summarized package-manager filter behavior and edge cases" },
        { type: "tool", name: "read", summary: "docs/settings.md" },
        { type: "tool", name: "write", summary: "notes/skills-behavior.md" },
        {
          type: "tool",
          name: "bash",
          summary: 'rg "sessionName|session_info" -n',
        },
      ],
    },
  },
  {
    name: "completed-collapsed-activities",
    details: {
      kind: "send",
      status: "done",
      async: true,
      agentName: "researcher",
      sessionId: "2f91a8c4-demo",
      message: "Determine the cleanest dependency-management approach for this Pi workspace after the Pi update.",
      answer:
        "Use the workspace lockfile as the canonical dependency source.\nThe package now preserves deterministic installs without unnecessary lockfile churn.\nThis third answer line should stay hidden while the card is collapsed.",
      startedAt: Date.now() - 450_000,
      completedAt: Date.now(),
      activities: Array.from({ length: 10 }, (_, index) => ({
        type: "tool",
        name: index % 2 === 0 ? "read" : "bash",
        summary: `validated activity ${index + 1}`,
      })),
    },
  },
  {
    name: "completed-expanded-answer",
    expanded: true,
    details: {
      kind: "send",
      status: "done",
      async: true,
      agentName: "builder",
      sessionId: "0de4f7aa-demo",
      message: "Implement the requested card behavior.",
      answer:
        "Implemented the completed-card presentation.\n\nChanges:\n- The answer is the primary body content.\n- The original request remains available as card state.\n- Matching assistant activity is shown once.",
      startedAt: Date.now() - 90_000,
      completedAt: Date.now(),
      activities: [
        {
          type: "assistant",
          text: "Implemented the completed-card presentation.\n\nChanges:\n- The answer is the primary body content.\n- The original request remains available as card state.\n- Matching assistant activity is shown once.",
        },
        { type: "tool", name: "edit", summary: "src/interface/cards/render.ts" },
        { type: "tool", name: "bash", summary: "220 tests passed" },
      ],
    },
  },
  {
    name: "load-agent",
    details: {
      kind: "load",
      status: "done",
      agentName: "builder",
      sessionId: "0de4f7aa-demo",
      message: "Loaded builder",
      configuration: {
        model: "openai-codex/gpt-5.4",
        thinking: "high",
        tools: ["read", "bash", "edit", "write", "agents"],
        agents: ["researcher", "reviewer"],
        skills: ["playwright-cli"],
      },
      systemPrompt:
        "You are the builder agent. You implement designs safely and keep Pi native functionality compatible.",
    },
  },
  {
    name: "queued-card",
    details: {
      kind: "send",
      status: "queued",
      async: true,
      agentName: "researcher",
      sessionId: "2f91a8c4-demo",
      message: "Continue the analysis after your current turn.",
      startedAt: Date.now() - 8_000,
      updatedAt: Date.now() - 8_000,
    },
  },
  {
    name: "stopped-card",
    details: {
      kind: "send",
      status: "stopped",
      agentName: "researcher",
      sessionId: "2f91a8c4-demo",
      error:
        "Session 2f91a8c [researcher] stopped before returning a final answer.\nReason: The model reached its output token limit before returning a final answer.\nRecent model error: Input exceeds the context window.\nRequest: Continue the analysis after your current turn.",
      startedAt: Date.now() - 18_000,
      completedAt: Date.now(),
    },
  },
  {
    name: "readable-status-card",
    details: {
      kind: "status",
      status: "done",
      sessionId: "2f91a8c4-demo",
      message:
        "Session 2f91a8c [researcher]\nState: running\nRunning for: 1m:10s\nLast activity: 12s ago\nQueued messages: 2\nRecent activity:\n- [read] done",
    },
  },
  {
    name: "error-card",
    details: {
      kind: "send",
      status: "error",
      agentName: "missing",
      sessionId: "bad00000-demo",
      error: 'Unknown agent "missing". Available agents: researcher, builder, reviewer.',
      startedAt: Date.now() - 3_000,
      completedAt: Date.now(),
    },
  },
  {
    name: "expanded-delegation",
    expanded: true,
    details: {
      kind: "delegation",
      status: "done",
      sessionId: "019fe6cd-demo",
      message: "Delegated from session 019fe6cc.",
      call: {
        toolCallId: "call_demo",
        callerEntryId: "entry_demo",
        parameters: {
          action: "send",
          agent: "researcher",
          message: "Research the requested sources.",
        },
        effectiveParameters: {
          action: "send",
          agent: "researcher",
          message: "Research the requested sources.",
          async: false,
          fork: false,
          cwd: "C:\\workspace",
        },
      },
    },
  },
  {
    name: "delegated-provider-error",
    details: {
      kind: "send",
      status: "error",
      async: true,
      agentName: "researcher",
      sessionId: "019fe679-demo",
      message: "Research the target resources in the background.",
      error:
        "Session 019fe679 [researcher] failed while handling your request.\nError: Your input exceeds the context window of this model.\nRequest: Research the target resources in the background.",
      activities: [
        {
          type: "assistant",
          text: "Your input exceeds the context window of this model.",
          status: "error",
        },
      ],
      startedAt: Date.now() - 18_000,
      completedAt: Date.now(),
    },
  },
];

for (const item of cases) {
  if (item.details.status === "running") {
    item.details.cardId ??= `capture:${item.name}`;
    setLiveCardDetails(item.details);
  }
  const component = renderAgentsResult(
    {
      content: [
        {
          type: "text",
          text: item.details.message ?? item.details.error ?? "",
        },
      ],
      details: item.details,
    },
    {
      expanded: item.expanded ?? item.name === "load-agent",
      isPartial: item.details.status === "running",
    },
    theme,
    { args: {}, isError: item.details.status === "error" },
  );

  for (const input of item.inputs ?? []) component.handleInput?.(input);
  const lines = component.render(width);

  if (item.details.status === "running") clearLiveCardDetails(item.details);
  const ansiPath = path.join(outputDir, `${item.name}.ansi`);
  const svgPath = path.join(outputDir, `${item.name}.svg`);
  const pngPath = path.join(outputDir, `${item.name}.png`);

  writeFileSync(ansiPath, `${lines.join("\n")}\n`, "utf8");

  writeFileSync(svgPath, toSvg(lines), "utf8");
  const result = spawnSync("magick", [svgPath, pngPath], {
    timeout: 15_000,
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    console.error(`Could not render ${pngPath}: ${result.error?.message ?? result.stderr}`);
  } else {
    console.log(pngPath);
  }
}

const loadCards = Array.from({ length: 48 }, (_, index) => ({
  cardId: `load-capture-${index}`,
  kind: "send",
  status: "running",
  livePanel: true,
  callerSessionId: "load-parent",
  sessionId: `load-session-${String(index).padStart(2, "0")}`,
  agentName: `worker-${String(index).padStart(2, "0")}`,
  async: true,
  message: `Process load task ${index}`,
  startedAt: Date.now() - 10_000,
  updatedAt: Date.now(),
  activities: [{ type: "tool", name: "read", summary: `load-${index}.ts` }],
}));
const loadRuntime = createExtensionRuntime();
let loadPanel;
const loadStop = startSessionLiveCardRefresh(
  {
    mode: "tui",
    sessionManager: { getSessionId: () => "load-parent", getEntries: () => [] },
    ui: {
      setWidget(_key, factory) {
        loadPanel = factory?.({ terminal: { rows: 54 }, requestRender() {} }, theme);
      },
    },
  },
  loadRuntime,
);

try {
  loadCards.forEach((card) => setLiveCardDetails(card));
  loadStop.refresh();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const lines = loadPanel.render(width);
  const svgPath = path.join(outputDir, "live-panel-48-sessions.svg");
  const pngPath = path.join(outputDir, "live-panel-48-sessions.png");

  writeFileSync(path.join(outputDir, "live-panel-48-sessions.ansi"), `${lines.join("\n")}\n`, "utf8");
  writeFileSync(svgPath, toSvg(lines), "utf8");
  const result = spawnSync("magick", [svgPath, pngPath], { timeout: 15_000, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    console.error(`Could not render ${pngPath}: ${result.error?.message ?? result.stderr}`);
  } else {
    console.log(pngPath);
  }
} finally {
  loadStop();
  loadCards.forEach(clearLiveCardDetails);
  await loadRuntime.dispose();
}

function color(name) {
  return (
    {
      dim: 90,
      muted: 90,
      accent: 95,
      warning: 93,
      error: 91,
      success: 92,
    }[name] ?? 37
  );
}

function toSvg(lines) {
  const cellWidth = 11;
  const lineHeight = 22;
  const margin = 18;
  const svgWidth = Math.ceil(width * cellWidth + margin * 2);
  const svgHeight = Math.ceil(lines.length * lineHeight + margin * 2);
  const textLines = lines
    .map(
      (line, index) =>
        `<text xml:space="preserve" x="${margin}" y="${margin + (index + 1) * lineHeight}">${ansiToSpans(line)}</text>`,
    )
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
<rect width="100%" height="100%" fill="#05080c"/>
<style>text{font-family:Consolas,Menlo,monospace;font-size:18px;white-space:pre}.b{font-weight:700}</style>
${textLines}
</svg>`;
}

function ansiToSpans(line) {
  const colors = {
    33: "#f59e0b",
    36: "#22d3ee",
    37: "#f4f4f5",
    39: "#f4f4f5",
    90: "#71717a",
    91: "#fb7185",
    92: "#7ee787",
    93: "#facc15",
    94: "#60a5fa",
    95: "#d946ef",
    96: "#67e8f9",
  };
  let currentColor = colors[37];
  let bold = false;
  let output = "";
  const regex = /\x1b\[([0-9;]*)m/g;
  let last = 0;

  for (const match of line.matchAll(regex)) {
    output += span(line.slice(last, match.index), currentColor, bold);

    for (const code of match[1].split(";").filter(Boolean).map(Number)) {
      if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (colors[code]) currentColor = colors[code];
    }
    last = match.index + match[0].length;
  }

  output += span(line.slice(last), currentColor, bold);

  return output;
}

function span(text, color, bold) {
  if (!text) return "";

  return `<tspan fill="${color}"${bold ? ' class="b"' : ""}>${escapeXml(text)}</tspan>`;
}

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
