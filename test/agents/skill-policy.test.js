import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { resolveTargetSlashCommand } from "../../dist/delegation/delivery.js";
import { applySessionSkillPolicy } from "../../dist/pi/skill-policy.js";

function skillFixture(root, name, description) {
  const baseDir = path.join(root, name);
  const filePath = path.join(baseDir, "SKILL.md");

  mkdirSync(baseDir, { recursive: true });
  writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\nUse ${name}.`);

  return {
    name,
    description,
    filePath,
    baseDir,
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
    disableModelInvocation: false,
  };
}

test("native Pi prompt construction and skill lookup honor the session skill policy", async (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-gentic-skill-policy-"));
  const agentDir = path.join(cwd, "agent");
  const skills = [
    skillFixture(cwd, "excluded-skill", "Must stay hidden."),
    skillFixture(cwd, "allowed-skill", "Must remain usable."),
  ];
  mkdirSync(agentDir, { recursive: true });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    skillsOverride: (loaded) => ({ ...loaded, skills }),
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  t.after(() => {
    session.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });

  applySessionSkillPolicy(session, ["!excluded-skill"]);
  session.setActiveToolsByName(session.getActiveToolNames());

  assert.deepEqual(
    session.resourceLoader.getSkills().skills.map((skill) => skill.name),
    ["allowed-skill"],
  );
  assert.doesNotMatch(session.systemPrompt, /excluded-skill|Must stay hidden/);
  assert.match(session.systemPrompt, /allowed-skill/);
  assert.equal(resolveTargetSlashCommand("/skill:excluded-skill do it", session), undefined);
  assert.equal(resolveTargetSlashCommand("/skill:allowed-skill do it", session)?.source, "skill");
});
