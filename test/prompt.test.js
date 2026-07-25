import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  "</available_skills>",
].join("\n");

function extensionInput(overrides = {}) {
  return {
    baseSystemPrompt: basePrompt,
    config: {
      agents: [
        { name: "researcher", description: "Finds reliable context" },
        { name: "builder", description: "Builds patches" },
      ],
      roots: [],
      diagnostics: [],
    },
    policy: {
      instructions: "Research instructions.",
      resources: {
        agents: ["researcher"],
        tools: ["agents", "read"],
        skills: ["tdd"],
      },
      systemPromptFiles: [],
    },
    ...overrides,
  };
}

test("resolved prompt preserves native Pi content and appends one delimited context", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-prompt-"));

  try {
    writeFileSync(path.join(dir, "extra.md"), "Extra prompt file content.");
    writeFileSync(path.join(dir, "DELEGATION.md"), "Delegation rules.");
    const input = extensionInput();
    input.config.roots = [dir];
    input.policy.systemPromptFiles = ["extra.md"];
    const prompt = buildResolvedSystemPrompt(input);

    assert.equal(prompt.slice(0, basePrompt.length), basePrompt);
    assert.match(prompt, /<pi-gentic-context>/);
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
    assert.equal([...prompt.matchAll(/<available_skills>/g)].length, 1);
    assert.equal([...prompt.matchAll(/Research instructions\./g)].length, 1);
    assert.ok(
      prompt.indexOf("Extra prompt file content.") <
        prompt.indexOf("Available agents"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent policy never removes native prompts, project instructions, or skills", () => {
  const input = extensionInput();
  input.policy.resources = {
    agents: ["researcher"],
    tools: ["read"],
    skills: [],
  };
  input.policy.systemPromptFiles = [
    "*",
    "!@agent/SYSTEM.md",
    "!*AGENTS.md",
  ];
  const prompt = buildResolvedSystemPrompt(input);

  assert.equal(prompt.slice(0, basePrompt.length), basePrompt);
  assert.match(prompt, /Base SYSTEM\.md prompt/);
  assert.match(prompt, /Project rules/);
  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /<name>tdd<\/name>/);
  assert.doesNotMatch(prompt, /Available agents/);
  assert.doesNotMatch(prompt, /3 words long max/);
});

test("skill entries are sourced from Pi instead of being synthesized", () => {
  const prompt = buildResolvedSystemPrompt({
    baseSystemPrompt: "Base SYSTEM.md prompt.",
    config: { agents: [], roots: [], diagnostics: [] },
    policy: {
      instructions: "Scoped instructions.",
      resources: { agents: [], tools: ["read"], skills: ["manual"] },
      systemPromptFiles: [],
    },
    skillEntries: [
      {
        name: "manual",
        description: "Extension-discovered skill",
        location: "C:/skills/manual/SKILL.md",
      },
    ],
  });

  assert.doesNotMatch(prompt, /<available_skills>/);
  assert.doesNotMatch(prompt, /Extension-discovered skill/);
  assert.match(prompt, /Scoped instructions/);
});

test("prompt files cannot escape trusted configuration roots", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-gentic-prompt-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "pi-gentic-prompt-outside-"));

  try {
    const outsideFile = path.join(outside, "outside.md");
    writeFileSync(outsideFile, "Untrusted prompt content.");
    const input = extensionInput();
    input.config.roots = [root];
    input.policy.systemPromptFiles = [outsideFile];
    const prompt = buildResolvedSystemPrompt(input);

    assert.doesNotMatch(prompt, /Untrusted prompt content/);
    assert.equal(input.config.diagnostics.length, 1);
    assert.match(input.config.diagnostics[0].message, /outside trusted/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
