import type {
  AgentSession,
  AgentSessionRuntime,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionManager,
  Theme,
} from "@earendil-works/pi-coding-agent";

export type UnknownRecord = Record<string, unknown>;

export type PiSessionManager = ExtensionContext["sessionManager"] &
  Partial<Pick<SessionManager, "appendCustomEntry" | "appendCustomMessageEntry" | "appendMessage">>;

export type PiApi = ExtensionAPI;

export type PiContext = Omit<ExtensionContext, "sessionManager"> &
  Partial<Omit<ExtensionCommandContext, keyof ExtensionContext>> & {
    sessionManager: PiSessionManager;
  };

export type PiAgentRuntimeHost = AgentSessionRuntime;
export type PiAgentSession = AgentSession;

export type PiRuntimeSession = {
  session: PiAgentSession;
  runtimeHost?: PiAgentRuntimeHost;
  agentName?: string;
  parentSessionId?: string;
  parentSessionPath?: string;
  lastMessage?: string;
  lastActivityAt?: string;
  createdAt?: string;
  lastActivities?: UnknownRecord[];
  runStartedAt?: number;
  streamingStartedAt?: string | number;
  lastAbort?: { actor?: string; at: number };
  activitySession?: PiAgentSession;
  activityUnsubscribe?: () => void;
  lastSeenAt?: number;
};

export type PiTheme = Theme;
