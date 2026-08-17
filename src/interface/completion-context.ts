import { SessionManager } from "@earendil-works/pi-coding-agent";
import { enrichSessionSummaries, findSessionSummary } from "../application/sessions/model.js";
import { buildSessionTree, sessionCompletionScope } from "../application/sessions/runtime-view.js";
import type { PiApi, PiContext } from "../infrastructure/pi/types.js";
import { enabledModelPatterns, loadConfiguration } from "../infrastructure/configuration/agents.js";
import { loadAvailableSkills, systemPromptSkillEntries } from "../infrastructure/configuration/skills.js";
import { recoverDiagnostic, reportRuntimeDiagnostic } from "../shared/diagnostics.js";
import type { UnknownRecord } from "../shared/types.js";
import { isRecord, recordArray, recordValue, stringArray } from "../shared/value.js";

type CompletionSnapshot = {
  cwd: string;
  sessionDir?: string;
  currentSessionId?: string;
  currentSessionPath?: string;
  agents: UnknownRecord[];
  models: UnknownRecord[];
  tools: string[];
  skills: string[];
  commands: UnknownRecord[];
  themes: string[];
  systemPromptFiles: string[];
};

export function createCompletionContext(pi: PiApi, onCapture?: (snapshot: UnknownRecord, ctx?: PiContext) => void) {
  let snapshot: CompletionSnapshot = {
    cwd: process.cwd(),
    agents: [],
    models: [],
    tools: [],
    skills: [],
    commands: [],
    themes: [],
    systemPromptFiles: [],
  };

  return {
    capture(ctx: PiContext | undefined) {
      if (!ctx) return snapshot;
      const cwd = typeof ctx.cwd === "string" ? ctx.cwd : snapshot.cwd;
      const projectTrusted = ctx.isProjectTrusted?.() === true;
      const config = loadConfiguration({ cwd, projectTrusted });
      const nativeSkills = systemPromptSkillEntries(ctx);
      snapshot = {
        cwd,
        sessionDir: ctx.sessionManager?.getSessionDir?.() ?? snapshot.sessionDir,
        currentSessionId: ctx.sessionManager?.getSessionId?.() ?? snapshot.currentSessionId,
        currentSessionPath: ctx.sessionManager?.getSessionFile?.() ?? snapshot.currentSessionPath,
        agents: config.agents,
        models: scopedModelSuggestions(ctx),
        tools: safeToolNames(pi),
        skills: (nativeSkills.length > 0 ? nativeSkills : loadAvailableSkills({ cwd, projectTrusted })).map(
          (skill) => skill.name,
        ),
        commands: safeCommands(pi),
        themes: themeSuggestions(config),
        systemPromptFiles: systemPromptFileSuggestions(config),
      };
      onCapture?.(snapshot, ctx);

      return snapshot;
    },
    current() {
      return snapshot;
    },
  };
}

export async function listCompletionSessions({
  cwd,
  sessionDir,
  currentSessionId,
  currentSessionPath,
}: {
  cwd: string;
  sessionDir?: string;
  currentSessionId?: string;
  currentSessionPath?: string;
}) {
  try {
    const persisted = await listCompletionSessionSources(cwd, sessionDir);
    const current =
      findSessionSummary(persisted, {
        id: currentSessionId,
        sessionId: currentSessionId,
        path: currentSessionPath,
      }) ??
      (currentSessionId || currentSessionPath
        ? {
            id: currentSessionId,
            sessionId: currentSessionId,
            path: currentSessionPath,
          }
        : undefined);
    const scoped = sessionCompletionScope(buildSessionTree(current, persisted), current, {
      rx: 4,
      ry: 4,
    });

    return enrichSessionSummaries(scoped, 20);
  } catch (error) {
    reportRuntimeDiagnostic("completion-sessions", error);
    return [];
  }
}

async function listCompletionSessionSources(cwd: string, sessionDir?: string) {
  const persisted = await SessionManager.list(cwd, sessionDir);

  return persisted.flatMap((session) => (isRecord(session) ? [session] : []));
}

function scopedModelSuggestions(ctx: PiContext | undefined) {
  const patterns = enabledModelPatterns() ?? [];
  const registry = ctx?.modelRegistry;
  const available = safeAvailableModels(registry);

  if (patterns.length === 0) return available;

  return patterns.map((pattern) => {
    const [provider, id] = String(pattern)
      .split(/\/(.*)/)
      .filter(Boolean);
    const match = provider && id ? registry?.find?.(provider, id) : undefined;

    return recordValue(match ?? { provider, id: id ?? pattern, label: pattern });
  });
}

function safeAvailableModels(modelRegistry: unknown): UnknownRecord[] {
  return recoverDiagnostic(
    "available-models",
    () =>
      isRecord(modelRegistry) && typeof modelRegistry.getAvailable === "function"
        ? recordArray(modelRegistry.getAvailable())
        : [],
    () => [],
  );
}

function safeToolNames(pi: PiApi) {
  return recoverDiagnostic(
    "available-tools",
    () => pi.getAllTools().map((tool) => tool.name),
    () => [],
  );
}

function safeCommands(pi: PiApi): UnknownRecord[] {
  return recoverDiagnostic(
    "available-commands",
    () => (pi.getCommands?.() ?? []).map(({ name, description }) => ({ name, description })),
    () => [],
  );
}

function systemPromptFileSuggestions(config: ReturnType<typeof loadConfiguration>) {
  const settings = recordValue(config.settings);
  const agentless = recordValue(settings.agentlessSession);
  const defaults = recordValue(settings.agentDefaults);
  const files = [
    ...stringArray(agentless.systemPromptFiles),
    ...stringArray(defaults.systemPromptFiles),
    ...config.agents.flatMap((agent: UnknownRecord) => stringArray(agent.systemPromptFiles)),
  ];

  return files.filter((file, index) => files.indexOf(file) === index);
}

function themeSuggestions(config: ReturnType<typeof loadConfiguration>) {
  const settings = recordValue(config.settings);
  const themes = [settings.theme, ...config.agents.map((agent) => agent.theme)].filter(
    (theme): theme is string => typeof theme === "string" && Boolean(theme),
  );

  return themes.filter((theme, index) => themes.indexOf(theme) === index);
}
