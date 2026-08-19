import type {
  AgentSession,
  AgentSessionRuntime,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { UnknownRecord } from "../shared/values.js";

export type PiSessionManager = ExtensionContext["sessionManager"] &
  Partial<Pick<SessionManager, "appendCustomEntry" | "appendCustomMessageEntry" | "appendMessage">>;

export type PiApi = ExtensionAPI;

export type PiContext = Omit<ExtensionContext, "sessionManager"> &
  Partial<Omit<ExtensionCommandContext, keyof ExtensionContext>> & {
    sessionManager: PiSessionManager;
  };

export type PiAgentRuntimeHost = AgentSessionRuntime;
export type PiAgentSession = AgentSession;

export type ReturnDeliveryGroup = {
  phase: "starting" | "running";
  participants: number;
};

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
  activePromptCount?: number;
  returnDeliveryGroups?: Map<string, ReturnDeliveryGroup>;
  lastAbort?: { actor?: string; at: number };
  activitySession?: PiAgentSession;
  activityUnsubscribe?: () => void;
  lastSeenAt?: number;
};

export type PiTheme = Theme;

/** Dynamic shape exposed by the installed Pi runtime. */
export type HostRecord = Record<string, any>;

export type SessionTransitionSubmission = {
  readonly text: string;
  readonly mode: HostRecord;
  readonly deliver: () => Promise<unknown>;
};

export type SessionTransition = {
  readonly destination: string;
  readonly submissions: SessionTransitionSubmission[];
  readonly previews: Map<HostRecord, { readonly spacer?: unknown; readonly text?: unknown }>;
  phase: "opening" | "ready" | "cancelled" | "failed";
  drain?: Promise<void>;
};
