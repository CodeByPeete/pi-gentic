import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildManualSkillMessage,
  completeSkill,
  parseSkillCommand,
} from "../dist/interface.js";
import {
  loadConfiguration,
  normalizeAgentDefinition,
  parseMarkdownDefinition,
} from "../dist/catalog.js";
import { loadAvailableSkills } from "../dist/catalog.js";
import {
  assertCanCreateSubagent,
  resolveSessionPolicy,
} from "../dist/catalog.js";

function tempRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gentic-test-"));

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("markdown parser extracts frontmatter and body", () => {
  const parsed = parseMarkdownDefinition(
    "---\nname: scout\nskills:\n  - read\n---\nBody",
  );

  assert.equal(parsed.frontmatter.name, "scout");

  assert.deepEqual(parsed.frontmatter.skills, ["read"]);

  assert.equal(parsed.body.trim(), "Body");
});

test("agent normalization accepts models alias", () => {
  const agent = normalizeAgentDefinition({
    name: "a",
    models: ["provider/model"],
  });

  assert.equal(agent.model, "provider/model");
});

test("agent normalization accepts comma-separated tools", () => {
  const agent = normalizeAgentDefinition({ name: "a", tools: "read, grep" });

  assert.deepEqual(agent.tools, ["read", "grep"]);
});

test("agent normalization ignores unnamed definitions", () => {
  const diagnostics = [];

  assert.equal(
    normalizeAgentDefinition({ description: "missing" }, "x", diagnostics),
    undefined,
  );

  assert.equal(diagnostics.length, 1);
});

test("configuration loads global settings and markdown agents", () => {
  const { dir, cleanup } = tempRoot();

  try {
    const root = path.join(dir, "extensions", "pi-gentic");
    mkdirSync(path.join(root, "agents"), { recursive: true });
    writeFileSync(
      path.join(root, "settings.json"),
      JSON.stringify({ globalMaxSubagentDepth: 4, defaultAgent: "researcher" }),
    );
    writeFileSync(
      path.join(root, "agents", "researcher.md"),
      "---\nname: researcher\ndescription: Research\n---\nDo research.",
    );
    const config = loadConfiguration({ agentDir: dir, cwd: dir });
    assert.equal(config.settings.globalMaxSubagentDepth, 4);
    assert.equal(config.settings.defaultAgent, "researcher");
    assert.equal(config.agents[0].name, "researcher");
    assert.equal(config.agents[0].instructions, "Do research.");
  } finally {
    cleanup();
  }
});

test("configuration leaves defaultAgent undefined when it is not configured", () => {
  const config = loadConfiguration({ roots: [] });

  assert.equal(config.settings.defaultAgent, undefined);
});

test("project agents override global agents", () => {
  const { dir, cleanup } = tempRoot();

  try {
    const globalRoot = path.join(
      dir,
      "agent",
      "extensions",
      "pi-gentic",
      "agents",
    );
    const projectRoot = path.join(
      dir,
      "work",
      ".pi",
      "extensions",
      "pi-gentic",
      "agents",
    );
    mkdirSync(globalRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      path.join(globalRoot, "a.md"),
      "---\nname: same\ndescription: global\n---\nglobal",
    );
    writeFileSync(
      path.join(projectRoot, "a.md"),
      "---\nname: same\ndescription: project\n---\nproject",
    );
    const config = loadConfiguration({
      agentDir: path.join(dir, "agent"),
      cwd: path.join(dir, "work"),
    });
    assert.equal(config.agents.length, 1);
    assert.equal(config.agents[0].description, "project");
  } finally {
    cleanup();
  }
});

test("available skills resolve from discovered skill files", () => {
  const { dir, cleanup } = tempRoot();

  try {
    const agentDir = path.join(dir, "agent");
    const cwd = path.join(dir, "work");
    mkdirSync(path.join(agentDir, "skills", "playwright-cli"), {
      recursive: true,
    });
    mkdirSync(path.join(cwd, ".agents", "skills", "local-scout"), {
      recursive: true,
    });
    writeFileSync(
      path.join(agentDir, "skills", "playwright-cli", "SKILL.md"),
      "---\nname: playwright-cli\ndescription: Browser automation\n---\nUse Playwright.",
    );
    writeFileSync(
      path.join(cwd, ".agents", "skills", "local-scout", "SKILL.md"),
      "---\nname: local-scout\ndescription: Local scout\n---\nScout locally.",
    );

    const skills = loadAvailableSkills({
      agentDir,
      cwd,
      skillRoots: [
        path.join(agentDir, "skills"),
        path.join(cwd, ".agents", "skills"),
      ],
    });

    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["playwright-cli", "local-scout"],
    );
    assert.equal(skills[0].description, "Browser automation");
    assert.match(skills[0].location, /SKILL\.md$/);
  } finally {
    cleanup();
  }
});

test("skill discovery follows root markdown and folder SKILL rules", () => {
  const { dir, cleanup } = tempRoot();

  try {
    const root = path.join(dir, "skills");
    mkdirSync(path.join(root, "folder-skill"), { recursive: true });
    mkdirSync(path.join(root, "nested"), { recursive: true });
    writeFileSync(
      path.join(root, "root-skill.md"),
      "---\nname: root-skill\ndescription: Root skill\n---\nRoot.",
    );
    writeFileSync(
      path.join(root, "folder-skill", "SKILL.md"),
      "---\nname: folder-skill\ndescription: Folder skill\n---\nFolder.",
    );
    writeFileSync(
      path.join(root, "nested", "ignored.md"),
      "---\nname: ignored\ndescription: Ignored\n---\nIgnored.",
    );

    const skills = loadAvailableSkills({ skillRoots: [root] });

    assert.deepEqual(
      skills.map((skill) => skill.name).sort(),
      ["folder-skill", "root-skill"],
    );
  } finally {
    cleanup();
  }
});

test("settings skills and package skills are discovered", () => {
  const { dir, cleanup } = tempRoot();

  try {
    const cwd = path.join(dir, "work");
    const explicit = path.join(dir, "explicit", "SKILL.md");
    const packageRoot = path.join(dir, "package");
    mkdirSync(path.dirname(explicit), { recursive: true });
    mkdirSync(path.join(packageRoot, "skills", "package-skill"), {
      recursive: true,
    });
    writeFileSync(
      explicit,
      "---\nname: explicit-skill\ndescription: Explicit skill\n---\nExplicit.",
    );
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "skill-package", pi: { skills: ["skills"] } }),
    );
    writeFileSync(
      path.join(packageRoot, "skills", "package-skill", "SKILL.md"),
      "---\nname: package-skill\ndescription: Package skill\n---\nPackage.",
    );
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({ skills: [explicit], packages: [packageRoot] }),
    );

    const skills = loadAvailableSkills({ cwd });

    assert.equal(
      skills.some((skill) => skill.name === "explicit-skill"),
      true,
    );

    assert.equal(
      skills.some((skill) => skill.name === "package-skill"),
      true,
    );
  } finally {
    cleanup();
  }
});

test("skill validation reports invalid definitions and duplicate names", () => {
  const { dir, cleanup } = tempRoot();

  try {
    const root = path.join(dir, "skills");
    mkdirSync(path.join(root, "a"), { recursive: true });
    mkdirSync(path.join(root, "b"), { recursive: true });
    mkdirSync(path.join(root, "missing"), { recursive: true });
    writeFileSync(
      path.join(root, "a", "SKILL.md"),
      "---\nname: duplicate\ndescription: First\nallowed-tools: read grep\ndisable-model-invocation: true\n---\nFirst.",
    );
    writeFileSync(
      path.join(root, "b", "SKILL.md"),
      "---\nname: duplicate\ndescription: Second\n---\nSecond.",
    );
    writeFileSync(
      path.join(root, "missing", "SKILL.md"),
      "---\nname: invalid name\n---\nMissing description.",
    );
    const diagnostics = [];
    const skills = loadAvailableSkills({ skillRoots: [root], diagnostics });

    assert.equal(skills.length, 1);

    assert.equal(skills[0].description, "First");

    assert.deepEqual(skills[0].allowedTools, ["read", "grep"]);

    assert.equal(skills[0].disableModelInvocation, true);

    assert.equal(diagnostics.length, 2);
  } finally {
    cleanup();
  }
});

test("skill command parsing, completions, and manual prompt formatting", () => {
  assert.deepEqual(parseSkillCommand('tdd "write tests"'), {
    name: "tdd",
    message: "write tests",
  });

  assert.deepEqual(completeSkill("td", { skills: ["tdd", "review"] }), [
    { value: "tdd", label: "tdd" },
  ]);

  assert.match(
    buildManualSkillMessage(
      {
        name: "tdd",
        description: "Test-first",
        location: "/skills/tdd/SKILL.md",
        allowedTools: ["read"],
        instructions: "Write a failing test first.",
      },
      "add coverage",
    ),
    /<skill_instructions>\nWrite a failing test first\.\n<\/skill_instructions>[\s\S]*Request:\nadd coverage/,
  );
});

test("noSkills suppresses discovery but keeps explicit settings skills", () => {
  const { dir, cleanup } = tempRoot();

  try {
    const root = path.join(dir, "skills");
    const explicit = path.join(dir, "explicit", "SKILL.md");
    mkdirSync(path.join(root, "normal"), { recursive: true });
    mkdirSync(path.dirname(explicit), { recursive: true });
    writeFileSync(
      path.join(root, "normal", "SKILL.md"),
      "---\nname: normal\ndescription: Normal\n---\nNormal.",
    );
    writeFileSync(
      explicit,
      "---\nname: explicit\ndescription: Explicit\n---\nExplicit.",
    );

    const skills = loadAvailableSkills({
      noSkills: true,
      skillRoots: [root],
      settings: { skills: [explicit] },
    });

    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["explicit"],
    );
  } finally {
    cleanup();
  }
});

test("disabled agents are removed", () => {
  const config = loadConfiguration({ roots: [] });
  config.settings.agentDefinitions = [{ name: "off", disabled: true }];
  const policy = resolveSessionPolicy({
    settings: config.settings,
    activeAgent: undefined,
    allAgents: ["on"],
    allTools: [],
    allSkills: [],
  });

  assert.deepEqual(policy.resources.agents, ["on"]);
});

test("policy resolves agent tools", () => {
  const policy = resolveSessionPolicy({
    settings: {
      agentDefaults: {},
      agentlessSession: {},
      globalMaxSubagentDepth: 6,
    },
    activeAgent: { name: "builder", tools: ["read", "write"] },
    allAgents: ["builder"],
    allTools: ["read", "write", "bash"],
    allSkills: [],
  });

  assert.deepEqual(policy.resources.tools, ["read", "write"]);
});

test("policy applies runtime overrides", () => {
  const policy = resolveSessionPolicy({
    settings: {
      agentDefaults: { tools: ["read"] },
      agentlessSession: {},
      globalMaxSubagentDepth: 6,
    },
    activeAgent: { name: "builder", model: "a" },
    overrides: { model: "b", tools: ["+bash"] },
    allAgents: ["builder"],
    allTools: ["read", "bash"],
    allSkills: [],
  });

  assert.equal(policy.model, "b");

  assert.deepEqual(policy.resources.tools, ["read", "bash"]);
});

test("policy merges system prompt file filters like other access lanes", () => {
  const policy = resolveSessionPolicy({
    settings: {
      agentDefaults: { systemPromptFiles: ["*", "!*.secret.md"] },
      agentlessSession: {},
      globalMaxSubagentDepth: 6,
    },
    activeAgent: {
      name: "builder",
      systemPromptFiles: ["+local.md", "!@agent/SYSTEM.md"],
    },
    overrides: { systemPromptFiles: ["-local.md"] },
    allAgents: ["builder"],
    allTools: [],
    allSkills: [],
  });

  assert.deepEqual(policy.systemPromptFiles, [
    "*",
    "!*.secret.md",
    "+local.md",
    "!@agent/SYSTEM.md",
    "-local.md",
  ]);
});

test("policy uses agentless defaults without active agent", () => {
  const policy = resolveSessionPolicy({
    settings: {
      agentDefaults: {},
      agentlessSession: { tools: ["read"], thinking: "low" },
      globalMaxSubagentDepth: 6,
    },
    allAgents: [],
    allTools: ["read", "write"],
    allSkills: [],
  });

  assert.equal(policy.thinking, "low");

  assert.deepEqual(policy.resources.tools, ["read"]);
});

test("policy defaults local subagent depth independently from global cap", () => {
  const agentless = resolveSessionPolicy({
    settings: {
      agentDefaults: {},
      agentlessSession: {},
      globalMaxSubagentDepth: 6,
    },
    allAgents: [],
    allTools: [],
    allSkills: [],
  });
  const active = resolveSessionPolicy({
    settings: {
      agentDefaults: {},
      agentlessSession: {},
      globalMaxSubagentDepth: 6,
    },
    activeAgent: { name: "builder" },
    allAgents: [],
    allTools: [],
    allSkills: [],
  });

  assert.equal(agentless.maxSubagentDepth, 1);
  assert.equal(active.maxSubagentDepth, 1);
});

test("subagent depth limit uses local budget and absolute global cap", () => {
  assert.doesNotThrow(() =>
    assertCanCreateSubagent({
      currentDepth: 5,
      maxSubagentDepth: 1,
      globalMaxSubagentDepth: 6,
    }),
  );

  assert.throws(
    () =>
      assertCanCreateSubagent({
        currentDepth: 6,
        maxSubagentDepth: 1,
        globalMaxSubagentDepth: 6,
      }),
    /globalMaxSubagentDepth is 6/,
  );

  assert.throws(
    () =>
      assertCanCreateSubagent({
        currentDepth: 1,
        maxSubagentDepth: 0,
        globalMaxSubagentDepth: 6,
      }),
    /maxSubagentDepth is 0/,
  );
});
