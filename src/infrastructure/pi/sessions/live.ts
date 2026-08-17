import { defaultAgentDir } from "../../configuration/agents.js";
import type { PiAgentRuntimeHost, PiAgentSession, PiRuntimeSession, PiSessionManager } from "../types.js";
import { loadPiCodingAgentPeer } from "../peer.js";
import { getLiveRuntimeState, type HostRecord } from "../state.js";

const LIVE_SESSION_PREFIX = "pi-gentic-live:";
const RUNTIME_ACTIVITY_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
]);

export function runtimeSessionIsRunning(runtime: PiRuntimeSession | undefined) {
  return Boolean(runtime && (runtime.session.isStreaming === true || Number(runtime.activePromptCount ?? 0) > 0));
}

export function livePath(sessionId: unknown) {
  return `${LIVE_SESSION_PREFIX}${sessionId}`;
}

export function liveSessionId(sessionPath: unknown) {
  if (typeof sessionPath !== "string" || !sessionPath.startsWith(LIVE_SESSION_PREFIX)) return undefined;
  return sessionPath.slice(LIVE_SESSION_PREFIX.length);
}

export async function createLiveRuntime({
  cwd,
  sessionManager,
}: {
  cwd: string;
  sessionManager: PiSessionManager;
}): Promise<PiAgentRuntimeHost> {
  const { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices } =
    await loadPiCodingAgentPeer();
  const agentDir = defaultAgentDir();
  const createRuntime = async (options: HostRecord) => {
    const services = await createAgentSessionServices({
      cwd: options.cwd,
      agentDir: options.agentDir,
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      sessionStartEvent: options.sessionStartEvent,
    });

    return {
      session: result.session,
      services,
      diagnostics: services.diagnostics,
      modelFallbackMessage: result.modelFallbackMessage,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager,
  });

  registerLiveRuntime(runtime);

  return runtime;
}

export function registerLiveRuntime(runtime: HostRecord, metadata: HostRecord = {}) {
  const sessionId = runtime.session.sessionManager.getSessionId();

  getLiveRuntimeState().liveRuntimes.set(sessionId, { runtime, metadata });

  return livePath(sessionId);
}

export function unregisterLiveRuntime(sessionId: string) {
  getLiveRuntimeState().liveRuntimes.delete(sessionId);
}

export function getRuntimeSession(sessionId: string) {
  return getLiveRuntimeState().runtimeSessions.get(sessionId);
}

export function findRuntimeSession(predicate: (runtime: PiRuntimeSession) => boolean) {
  return [...getLiveRuntimeState().runtimeSessions.values()].find(predicate);
}

export function isSessionActivityEvent(event: unknown) {
  return Boolean(
    event && typeof event === "object" && RUNTIME_ACTIVITY_EVENTS.has(String((event as HostRecord).type ?? "")),
  );
}

function syncRuntimeActivityTracking(sessionId: string, runtime: PiRuntimeSession) {
  const session = runtime.session;

  if (runtime.activitySession === session) return;
  stopRuntimeActivityTracking(runtime);

  if (!session || typeof session.subscribe !== "function") return;
  runtime.activitySession = session;
  runtime.activityUnsubscribe = session.subscribe((event: unknown) => {
    if (!isSessionActivityEvent(event)) return;
    const current = getRuntimeSession(sessionId);

    if (current !== runtime || current.session !== session) return;
    runtime.lastActivityAt = new Date(Date.now()).toISOString();
  });
}

function stopRuntimeActivityTracking(runtime: PiRuntimeSession | undefined) {
  runtime?.activityUnsubscribe?.();

  if (!runtime) return;
  delete runtime.activityUnsubscribe;
  delete runtime.activitySession;
}

export function setRuntimeSession(sessionId: string, runtime: PiRuntimeSession) {
  const runtimeSessions = getLiveRuntimeState().runtimeSessions;
  const existing = runtimeSessions.get(sessionId);
  const next = existing ?? runtime;

  Object.assign(next, runtime, { lastSeenAt: Date.now() });
  runtimeSessions.set(sessionId, next);
  syncRuntimeActivityTracking(sessionId, next);
  pruneRuntimeSessions();

  return next;
}

export function listRuntimeSessions() {
  return [...getLiveRuntimeState().runtimeSessions.values()];
}

export function deleteRuntimeSession(sessionId: string) {
  const runtimeSessions = getLiveRuntimeState().runtimeSessions;

  stopRuntimeActivityTracking(runtimeSessions.get(sessionId));
  runtimeSessions.delete(sessionId);
}

export function pruneRuntimeSessions({ maxEntries = 100, maxIdleMs = 12 * 60 * 60_000 } = {}) {
  const now = Date.now();
  const runtimeSessions = getLiveRuntimeState().runtimeSessions;

  for (const [sessionId, runtime] of runtimeSessions) {
    const running = runtime.session?.isStreaming === true;
    const lastSeenAt = Number(runtime.lastSeenAt ?? 0);

    if (!running && lastSeenAt && now - lastSeenAt > maxIdleMs) deleteRuntimeSession(sessionId);
  }

  const entries = [...runtimeSessions.entries()];

  if (entries.length <= maxEntries) return;
  const removable = entries
    .filter(([, runtime]) => !runtimeSessionIsRunning(runtime))
    .sort(([, a], [, b]) => Number(a.lastSeenAt ?? 0) - Number(b.lastSeenAt ?? 0));

  for (const [sessionId] of removable.slice(0, Math.max(0, entries.length - maxEntries)))
    deleteRuntimeSession(sessionId);
}

export function persistSessionImmediately(sessionManager: PiSessionManager) {
  const hostManager = sessionManager as unknown as HostRecord;

  if (typeof hostManager._rewriteFile === "function") hostManager._rewriteFile();
  hostManager.flushed = true;
}

export function resolveModelFromCatalog(modelCatalog: HostRecord, modelName: string) {
  if (modelName.includes("/")) {
    const [provider, id] = modelName.split("/", 2);

    return modelCatalog.find?.(provider, id) ?? modelCatalog.getModel?.(provider, id);
  }

  const available = modelCatalog.getAvailableSnapshot?.() ?? modelCatalog.getAvailable?.();
  const models = Array.isArray(available) ? available : (modelCatalog.getModels?.() ?? []);

  return (
    models.find((model: HostRecord) => model.id === modelName) ??
    models.find((model: HostRecord) => model.id.toLowerCase().includes(modelName.toLowerCase()))
  );
}

export function inheritedModelForPolicy(policy: HostRecord, inheritedModel: HostRecord | undefined) {
  if (policy?.model || !inheritedModel?.provider || !inheritedModel?.id) return undefined;
  return { provider: inheritedModel.provider, id: inheritedModel.id };
}

export async function applyInheritedModel(
  session: PiAgentSession,
  policy: HostRecord,
  inheritedModel: HostRecord | undefined,
) {
  const modelRef = inheritedModelForPolicy(policy, inheritedModel);

  if (!modelRef) return undefined;
  const model =
    resolveModelFromCatalog(
      (session as unknown as HostRecord).modelRegistry ?? session.modelRuntime,
      `${modelRef.provider}/${modelRef.id}`,
    ) ?? inheritedModel;

  if (modelsEqual(session.model, model)) return model;

  await session.setModel(model);

  return model;
}

function modelsEqual(a: HostRecord | undefined, b: HostRecord | undefined) {
  return a?.provider === b?.provider && a?.id === b?.id;
}
