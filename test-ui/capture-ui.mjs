import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createSessionTreePicker,
  renderAgentsResult,
  renderSessionTree,
} from "../dist/ui.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(root, "output");
const width = Number(process.env.PI_GENTIC_UI_CAPTURE_WIDTH ?? 120);
mkdirSync(outputDir, { recursive: true });

const theme = {
  bold: (text) => `\x1b[1m${text}\x1b[22m`,

  fg: (name, text) => `\x1b[${color(name)}m${text}\x1b[39m`,
};

function demoSessions(count) {
  const agents = [
    "orchestrator",
    "reviewer",
    "scout",
    "builder",
    "researcher",
    "tester",
    "writer",
    "navigator",
  ];
  const messages = [
    "Main planning session for subagent architecture",
    "Review auth refactor and edge cases",
    "Scan codebase for session manager hooks and events",
    "Prototype extension-driven session tree renderer",
    "Investigate skills config name resolution",
    "Verify package-manager filters for skills",
    "Draft simpler explanation for SDK vs extension scope",
    "TUI tree navigation and selector compatibility",
  ];

  return Array.from({ length: count }, (_, index) => ({
    sessionId: `${String(index + 1).padStart(2, "0")}f91a8c4-demo`,
    agentName: agents[index % agents.length],
    lastMessage: messages[index % messages.length],
    depth: index % 6 === 0 ? 0 : index % 3 === 0 ? 2 : 1,
    isLast: index % 3 === 2,
    running: index % 7 === 0,
    inactiveMs: 3_000 + index * 53_000,
  }));
}

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
    name: "session-tree",
    sessionTree: true,
    details: { sessions: demoSessions(22) },
  },
  {
    name: "session-tree-navigable",
    sessionTreePicker: true,
    inputs: ["\x1b[6~"],
    details: { sessions: demoSessions(22) },
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
        "Session 2f91a8c [researcher] stopped before returning a final answer.\nRequest: Continue the analysis after your current turn.",
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
      error:
        'Unknown agent "missing". Available agents: researcher, builder, reviewer.',
      startedAt: Date.now() - 3_000,
      completedAt: Date.now(),
    },
  },
];

for (const item of cases) {
  const component = item.sessionTreePicker
    ? createSessionTreePicker(
        item.details.sessions,
        theme,
        () => {},
        () => {},
      )
    : item.sessionTree
      ? renderSessionTree(item.details, theme)
      : renderAgentsResult(
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
            expanded: item.name === "load-agent",
            isPartial: item.details.status === "running",
          },
          theme,
          { args: {}, isError: item.details.status === "error" },
        );

  for (const input of item.inputs ?? []) component.handleInput?.(input);
  const lines = component.render(width);
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
    console.error(
      `Could not render ${pngPath}: ${result.error?.message ?? result.stderr}`,
    );
  } else {
    console.log(pngPath);
  }
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
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
