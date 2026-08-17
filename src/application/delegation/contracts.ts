import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { loadConfiguration } from "../../infrastructure/configuration/agents.js";
import type { PiAgentSession, PiApi, PiContext, PiSessionManager } from "../../infrastructure/pi/types.js";
import type { UnknownRecord } from "../../shared/types.js";
import type { resolveSessionPolicy } from "../../domain/session-policy.js";

export type Configuration = ReturnType<typeof loadConfiguration>;
export type SessionPolicy = ReturnType<typeof resolveSessionPolicy>;

export interface SendCompletionOptions {
  async?: boolean;
  awaitCompletion?: boolean;
}

export interface SendCardDetails extends UnknownRecord {
  status?: string;
  agentName?: string;
  error?: string;
}

export interface SendInput extends UnknownRecord {
  message: string;
  agent?: string;
  sessionId?: string;
  async?: boolean;
  fork?: boolean;
  cwd?: string;
  worktree?: string | true;
  repo?: string;
  invokeMeLater?: boolean;
  overrides?: UnknownRecord;
}

export interface SendCallbacks extends UnknownRecord {
  awaitCompletion?: boolean;
  onRefresh?: (details: UnknownRecord) => void;
  onUpdate?: AgentToolUpdateCallback<unknown>;
  signal?: AbortSignal;
  call?: UnknownRecord;
  onSettled?: () => void;
}

export type DeliveryQueue = "followUp" | "steer";

export type SessionController = Pick<
  PiAgentSession,
  "isStreaming" | "sessionManager" | "subscribe" | "sendCustomMessage" | "sendUserMessage"
> & {
  createReplacedSessionContext?: () => PiContext;
};

export interface ReturnDeliveryParameters {
  pi: PiApi;
  ctx: PiContext;
  callerSessionId?: string;
  callerSessionManager: PiSessionManager;
  text: string;
  invoke: boolean;
  persist?: (sessionManager: PiSessionManager) => unknown;
  invokeInactiveCaller?: (message: unknown) => Promise<unknown>;
  visibleSession?: SessionController;
  queue?: DeliveryQueue;
}

export interface CardDeliveryParameters extends ReturnDeliveryParameters {
  details: UnknownRecord;
}

export interface CallerCardParameters {
  callerSessionId?: string;
  callerSessionManager: PiSessionManager;
  callerCwd: string;
  config: Configuration;
  text: string;
  details: UnknownRecord;
  invoke: boolean;
  queue?: DeliveryQueue;
}

export interface CallerInvocationParameters {
  callerSessionManager: PiSessionManager;
  callerCwd: string;
  message: unknown;
  config: Configuration;
  queue?: DeliveryQueue;
}
