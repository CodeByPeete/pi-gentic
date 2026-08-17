import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { AgentsToolInput } from "../../domain/agents-tool.js";
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

export type SendInput = Omit<Extract<AgentsToolInput, { action: "send" }>, "action">;

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

export interface CardDeliveryParameters {
  pi: PiApi;
  ctx: PiContext;
  callerSessionId?: string;
  callerSessionManager: PiSessionManager;
  text: string;
  details: UnknownRecord;
  invoke: boolean;
  persist?: (sessionManager: PiSessionManager) => unknown;
  invokeInactiveCaller?: (message: unknown) => Promise<unknown>;
  visibleSession?: SessionController;
  queue?: DeliveryQueue;
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
