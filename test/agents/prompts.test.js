import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildResolvedSystemPrompt } from "../../dist/agents/prompts.js";
import { loadConfiguration } from "../../dist/settings.js";
import { resolveSessionPolicy } from "../../dist/sessions/policy.js";

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

function withResolvedPromptFixture(
  {
    globalRules,
    projectRules,
    globalDefaults,
    projectDefaults,
    globalFiles = {},
    projectFiles = {},
    globalAgents = [],
    projectAgents = [],
    activeAgentName,
  },
  assertPrompt,
) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-prompt-roots-"));
  const roots = {
    global: path.join(dir, "global"),
    project: path.join(dir, "project"),
  };

  try {
    for (const [scope, rules, defaults, agentDefinitions] of [
      ["global", globalRules, globalDefaults, globalAgents],
      ["project", projectRules, projectDefaults, projectAgents],
    ]) {
      mkdirSync(roots[scope], { recursive: true });
      writeFileSync(
        path.join(roots[scope], "settings.json"),
        JSON.stringify({
          agentDefaults: { systemPromptFiles: defaults },
          agentlessSession: { systemPromptFiles: rules },
          agentDefinitions,
        }),
      );
    }

    for (const [scope, files] of [
      ["global", globalFiles],
      ["project", projectFiles],
    ]) {
      for (const [filePath, content] of Object.entries(files)) {
        const destination = path.join(roots[scope], filePath);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, content);
      }
    }

    const config = loadConfiguration({ roots: [roots.global, roots.project] });
    const activeAgent = config.agents.find((agent) => agent.name === activeAgentName);
    const policy = resolveSessionPolicy({
      settings: config.settings,
      activeAgent,
      allAgents: [],
      allTools: [],
      allSkills: [],
    });

    assertPrompt(buildResolvedSystemPrompt({ baseSystemPrompt: "Base", config: { ...config, activeAgent }, policy }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    assert.match(prompt, /Available agents\n- researcher: Finds reliable context/);
    assert.match(prompt, /When generating a session or worktree name, it must be 3 words long max\./);
    assert.equal([...prompt.matchAll(/<available_skills>/g)].length, 1);
    assert.equal([...prompt.matchAll(/Research instructions\./g)].length, 1);
    assert.ok(prompt.indexOf("Extra prompt file content.") < prompt.indexOf("Available agents"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project prompt references resolve from the configuration root that declares them", () => {
  withResolvedPromptFixture(
    {
      globalRules: ["+prompts/shared.md"],
      projectRules: ["*", "+prompts/shared.md"],
      globalFiles: { "prompts/shared.md": "Global shared prompt." },
      projectFiles: { "prompts/shared.md": "Project shared prompt." },
    },
    (prompt) => {
      assert.match(prompt, /Project shared prompt/);
      assert.doesNotMatch(prompt, /Global shared prompt/);
    },
  );
});

test("an inactive project agent cannot redirect an agentless prompt reference", () => {
  withResolvedPromptFixture(
    {
      globalRules: ["+prompts/shared.md"],
      projectRules: ["*"],
      globalFiles: { "prompts/shared.md": "Global agentless prompt." },
      projectFiles: { "prompts/shared.md": "Inactive project agent prompt." },
      projectAgents: [{ name: "builder", systemPromptFiles: ["+prompts/shared.md"] }],
    },
    (prompt) => {
      assert.match(prompt, /Global agentless prompt/);
      assert.doesNotMatch(prompt, /Inactive project agent prompt/);
    },
  );
});

test("agent defaults cannot be redirected by an agentless project prompt", () => {
  withResolvedPromptFixture(
    {
      globalRules: ["*"],
      projectRules: ["*", "+prompts/shared.md"],
      globalDefaults: ["+prompts/shared.md"],
      projectDefaults: ["*"],
      globalFiles: { "prompts/shared.md": "Global agent default prompt." },
      projectFiles: { "prompts/shared.md": "Project agentless prompt." },
      globalAgents: [{ name: "builder" }],
      activeAgentName: "builder",
    },
    (prompt) => {
      assert.match(prompt, /Global agent default prompt/);
      assert.doesNotMatch(prompt, /Project agentless prompt/);
    },
  );
});

test("project prompt rules layer additions and removals over global prompt rules", () => {
  withResolvedPromptFixture(
    {
      globalRules: ["+prompts/global.md", "+prompts/removed.md"],
      projectRules: ["*", "-prompts/removed.md", "+prompts/local.md"],
      globalFiles: {
        "prompts/global.md": "Global inherited prompt.",
        "prompts/removed.md": "Removed global prompt.",
      },
      projectFiles: { "prompts/local.md": "Local added prompt." },
    },
    (prompt) => {
      assert.match(prompt, /Global inherited prompt/);
      assert.match(prompt, /Local added prompt/);
      assert.doesNotMatch(prompt, /Removed global prompt/);
    },
  );
});

test("project prompt exclusions remove inherited wildcard matches", () => {
  withResolvedPromptFixture(
    {
      globalRules: ["prompts/inherited.md"],
      projectRules: ["*", "!prompts/*.md", "+prompts/local.txt"],
      globalFiles: { "prompts/inherited.md": "Excluded inherited prompt." },
      projectFiles: { "prompts/local.txt": "Included local prompt." },
    },
    (prompt) => {
      assert.match(prompt, /Included local prompt/);
      assert.doesNotMatch(prompt, /Excluded inherited prompt/);
    },
  );
});

test("an empty project prompt rule list clears inherited prompts", () => {
  withResolvedPromptFixture(
    {
      globalRules: ["+prompts/inherited.md"],
      projectRules: [],
      globalFiles: { "prompts/inherited.md": "Inherited prompt." },
    },
    (prompt) => assert.equal(prompt, "Base"),
  );
});

test("agent policy never removes native prompts, project instructions, or skills", () => {
  const input = extensionInput();
  input.policy.resources = {
    agents: ["researcher"],
    tools: ["read"],
    skills: [],
  };
  input.policy.systemPromptFiles = ["*", "!@agent/SYSTEM.md", "!*AGENTS.md"];
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
