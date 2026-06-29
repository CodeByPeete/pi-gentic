import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildResolvedSystemPrompt } from "../dist/catalog.js";

const basePrompt = [
  "Base SYSTEM.md prompt.",
  "",
  "<project_context>",
  '<project_instructions path="AGENTS.md">',
  "Project rules.",
  "</project_instructions>",
  "</project_context>",
  "",
  "The following skills provide specialized instructions for specific tasks.",
  "Use the read tool to load a skill's file when the task matches its description.",
  "",
  "<available_skills>",
  "  <skill>",
  "    <name>tdd</name>",
  "    <description>Test-first development</description>",
  "    <location>C:/skills/tdd/SKILL.md</location>",
  "  </skill>",
  "  <skill>",
  "    <name>frontend-design</name>",
  "    <description>Frontend design</description>",
  "    <location>C:/skills/frontend-design/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
].join("\n");

test("resolved prompt is readable, de-duplicated, and policy-scoped", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-prompt-"));
  const extraFile = path.join(dir, "extra.md");

  writeFileSync(extraFile, "Extra prompt file content.");

  writeFileSync(path.join(dir, "DELEGATION.md"), "Delegation rules.");

  const prompt = buildResolvedSystemPrompt({
    baseSystemPrompt: basePrompt,
    config: {
      agents: [
        { name: "researcher", description: "Finds reliable context" },
        { name: "builder", description: "Builds patches" },
      ],
      roots: [dir],
    },
    policy: {
      instructions: "Research instructions.",
      resources: {
        agents: ["researcher"],
        tools: ["agents", "read"],
        skills: ["tdd"],
      },
      systemPromptFiles: ["*", "extra.md"],
    },
  });

  assert.match(prompt, /Base SYSTEM\.md prompt/);

  assert.match(prompt, /Project rules/);

  assert.match(prompt, /Research instructions/);

  assert.match(prompt, /Delegation rules/);

  assert.match(prompt, /Extra prompt file content/);

  assert.match(
    prompt,
    /Available agents\n- researcher: Finds reliable context/,
  );

  assert.match(
    prompt,
    /When generating a session or worktree name, it must be 3 words long max\./,
  );

  assert.match(prompt, /<available_skills>/);

  assert.match(prompt, /<name>tdd<\/name>/);

  assert.match(prompt, /<location>C:\/skills\/tdd\/SKILL\.md<\/location>/);

  assert.ok(
    prompt.indexOf("Extra prompt file content.") <
      prompt.indexOf("Available agents"),
  );

  assert.ok(
    prompt.indexOf("Available agents") <
      prompt.indexOf("When generating a session or worktree name"),
  );

  assert.ok(
    prompt.indexOf("When generating a session or worktree name") <
      prompt.indexOf("<available_skills>"),
  );

  assert.match(
    prompt,
    /Research instructions\.\n\nDelegation rules\.\n\nExtra prompt file content\.\n\nAvailable agents/,
  );

  assert.doesNotMatch(prompt, /frontend-design/);

  assert.equal([...prompt.matchAll(/Research instructions\./g)].length, 1);
});

test("resolved prompt omits agents and delegation when agents tool is unavailable", () => {
  const prompt = buildResolvedSystemPrompt({
    baseSystemPrompt: basePrompt,
    config: {
      agents: [{ name: "researcher", description: "Finds reliable context" }],
      roots: [],
    },
    policy: {
      instructions: "Scoped instructions.",
      resources: { agents: ["researcher"], tools: ["read"], skills: [] },
      systemPromptFiles: [],
    },
  });

  assert.doesNotMatch(prompt, /Available agents/);

  assert.doesNotMatch(prompt, /Finds reliable context/);

  assert.doesNotMatch(prompt, /Available skills/);

  assert.doesNotMatch(prompt, /3 words max/);

  assert.doesNotMatch(prompt, /<available_skills>/);
});

test("system prompt file filters can exclude built-in prompt sources by pattern", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-prompt-filter-"));

  writeFileSync(path.join(dir, "DELEGATION.md"), "Delegation rules.");

  const prompt = buildResolvedSystemPrompt({
    baseSystemPrompt: basePrompt,
    config: {
      agents: [{ name: "researcher", description: "Finds reliable context" }],
      roots: [dir],
    },
    policy: {
      instructions: "Scoped instructions.",
      resources: { agents: ["researcher"], tools: ["agents"], skills: [] },
      systemPromptFiles: [
        "*",
        "!@agent/SYSTEM.md",
        "!*AGENTS.md",
        "!@agent/extensions/pi-gentic/DELEGATION.md",
      ],
    },
  });

  assert.doesNotMatch(prompt, /Base SYSTEM\.md prompt/);

  assert.doesNotMatch(prompt, /Project rules/);

  assert.doesNotMatch(prompt, /Delegation rules/);

  assert.match(prompt, /Scoped instructions/);

  assert.match(prompt, /Available agents/);
});

test("resolved prompt excludes skills hidden from model invocation", () => {
  const prompt = buildResolvedSystemPrompt({
    baseSystemPrompt: "Base SYSTEM.md prompt.",
    config: { agents: [], roots: [] },
    policy: {
      instructions: "Scoped instructions.",
      resources: { agents: [], tools: ["read"], skills: ["manual-only", "visible"] },
      systemPromptFiles: [],
    },
    skillEntries: [
      {
        name: "manual-only",
        description: "Manual only",
        location: "C:/skills/manual/SKILL.md",
        disableModelInvocation: true,
      },
      {
        name: "visible",
        description: "Visible skill",
        location: "C:/skills/visible/SKILL.md",
      },
    ],
  });

  assert.doesNotMatch(prompt, /manual-only/);

  assert.match(prompt, /<name>visible<\/name>/);
});

test("resolved prompt can render configured skills even when the base prompt has no native skill block", () => {
  const prompt = buildResolvedSystemPrompt({
    baseSystemPrompt: "Base SYSTEM.md prompt.",
    config: { agents: [], roots: [] },
    policy: {
      instructions: "Scoped instructions.",
      resources: { agents: [], tools: ["read"], skills: ["playwright-cli"] },
      systemPromptFiles: [],
    },
    skillEntries: [
      {
        name: "playwright-cli",
        description: "Automate browser interactions",
        location: "C:/Users/petro/.agents/skills/playwright-cli/SKILL.md",
      },
    ],
  });

  assert.match(prompt, /<available_skills>/);

  assert.match(prompt, /<name>playwright-cli<\/name>/);

  assert.match(
    prompt,
    /<location>C:\/Users\/petro\/.agents\/skills\/playwright-cli\/SKILL\.md<\/location>/,
  );
});
