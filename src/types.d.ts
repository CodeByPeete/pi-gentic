type AnyRecord = Record<string, unknown> & {
  action?: string;
  activities?: AnyRecord[];
  agent?: string;
  agentName?: string;
  agents?: AnyRecord[];
  args?: AnyRecord;
  async?: boolean;
  cardId?: string;
  completedAt?: number;
  configuration?: AnyRecord;
  content?: unknown;
  cwd?: string;
  data?: AnyRecord;
  description?: string;
  details?: AnyRecord;
  error?: string;
  firstMessage?: string;
  expanded?: boolean;
  fork?: boolean;
  id?: string;
  inactiveMs?: number;
  isError?: boolean;
  isPartial?: boolean;
  invokeMeLater?: boolean;
  isLast?: boolean;
  kind?: string;
  label?: string;
  lastActivityAt?: string | number | Date;
  lastMessage?: string;
  livePath?: string;
  message?: string;
  modified?: string | number | Date;
  name?: string;
  onRefresh?: (details?: AnyRecord) => void;
  onSettled?: () => void;
  onUpdate?: (update: AnyRecord) => void;
  overrides?: AnyRecord;
  parentSessionPath?: string;
  path?: string;
  resources?: { agents?: string[]; tools?: string[]; skills?: string[] };
  restored?: boolean;
  root?: string;
  running?: boolean;
  rx?: number;
  ry?: number;
  sessionId?: string;
  sessions?: AnyRecord[];
  settings?: AnyRecord;
  shortId?: string;
  signal?: AbortSignal;
  skillRoots?: string[];
  sourcePath?: string;
  startedAt?: number;
  status?: string;
  text?: string;
  tools?: string[];
  systemPrompt?: string;
  updatedAt?: number;
  value?: string;
};

type PiSessionManager = {
  appendCustomEntry?: (type: string, data: unknown) => void;
  appendCustomMessageEntry?: (
    type: string,
    content: unknown,
    display?: boolean,
    details?: AnyRecord,
  ) => void;
  appendMessage?: (message: unknown) => void;
  appendSessionInfo?: (message: string) => void;
  buildSessionContext?: () => { messages: unknown[] };
  createBranchedSession?: (targetLeafId?: string) => string | undefined;
  flushed?: boolean;
  getBranch?: () => unknown[];
  getCwd?: () => string;
  getEntries?: () => unknown[];
  getHeader?: () => { parentSession?: string };
  getSessionDir?: () => string;
  getSessionFile?: () => string | undefined;
  getSessionId?: () => string;
  getSessionName?: () => string | undefined;
  isPersisted?: () => boolean;
  newSession?: (options?: AnyRecord) => void;
  _rewriteFile?: () => void;
};

type PiApi = {
  getAllTools: () => Array<{ name: string }>;
  sendMessage: (message: AnyRecord, options?: AnyRecord) => void;
  sendUserMessage: (text: string, options?: AnyRecord) => void;
  setActiveTools: (tools: string[]) => void;
  setModel: (model: unknown) => Promise<void> | void;
  setTheme: (theme: string) => void;
  setThinkingLevel: (thinking: string) => void;
};

type PiRuntimeSession = AnyRecord & {
  runtimeHost?: PiAgentRuntimeHost;
  session: PiAgentSession;
  agentName?: string;
  parentSessionPath?: string;
  lastAbort?: AnyRecord;
  runStartedAt?: number;
  lastActivities?: AnyRecord[];
  lastActivityAt?: string;
  lastMessage?: string;
  createdAt?: string;
};

type PiAgentRuntimeHost = AnyRecord & {
  session: PiAgentSession & { dispose?: () => void; sessionFile?: string };
  services: AnyRecord;
  diagnostics?: unknown[];
  modelFallbackMessage?: string;
  emitBeforeSwitch: (
    reason: string,
    targetSessionFile?: string,
  ) => Promise<{ cancelled: boolean }>;
  teardownCurrent: (reason: string, targetSessionFile?: string) => Promise<void>;
  apply: (result: AnyRecord) => void;
  finishSessionReplacement: (withSession?: unknown) => Promise<void>;
};

type PiAgentSession = {
  agent: { state: { messages: unknown[]; model?: unknown } };
  isStreaming: boolean;
  modelRegistry: {
    getAvailable: () => unknown[];
    find: (provider: string, id: string) => unknown;
  };
  pendingMessageCount?: number;
  resourceLoader: { getSkills: () => { skills: Array<{ name: string }> } };
  sessionManager: PiSessionManager;
  setActiveToolsByName: (tools: string[]) => void;
  setModel: (model: unknown) => Promise<void> | void;
  setThinkingLevel: (thinking: string) => void;
  getAllTools: () => Array<{ name: string }>;
  abort: () => Promise<void>;
  prompt: (message: string, options?: AnyRecord) => Promise<unknown>;
  sendCustomMessage?: (message: AnyRecord, options?: AnyRecord) => Promise<void>;
  sendUserMessage?: (content: unknown, options?: AnyRecord) => Promise<void>;
  subscribe?: (listener: (event: unknown) => void) => () => void;
};

type PiContext = {
  abort?: () => void;
  cwd: string;
  isIdle?: () => boolean;
  mode?: string;
  model?: unknown;
  modelRegistry?: {
    getAvailable?: () => unknown[];
    find?: (provider: string, id: string) => unknown;
  };
  getAllTools?: () => Array<{ name: string }>;
  sessionManager: PiSessionManager;
  shutdown?: () => void;
  switchSession?: (
    sessionPath: string,
    options?: { withSession?: (ctx: PiContext) => void | Promise<void> },
  ) => Promise<unknown>;
  ui: {
    custom?: <T>(
      factory: (
        tui: { requestRender: () => void },
        theme: PiTheme,
        keybindings: unknown,
        done: (value: T) => void,
      ) => unknown,
      options?: AnyRecord,
    ) => Promise<T>;
    notify?: (message: string, level?: string) => void;
    setTheme?: (theme: string) => void;
    setWidget?: (key: string, widget: unknown, options?: AnyRecord) => void;
  };
};

type PiTheme = {
  bold: (text: string) => string;
  fg: (name: string, text: string) => string;
  border?: string;
  dim?: string;
  green?: string;
  red?: string;
  cyan?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  text?: string;
  [key: string]: unknown;
};

declare module "@earendil-works/pi-coding-agent" {
  export class AgentSession {
    sessionManager: PiSessionManager;
    isStreaming: boolean;
    abort(): Promise<void>;
    dispose(): void;
    prompt(message: string, options?: AnyRecord): Promise<unknown>;
    subscribe?(listener: (event: unknown) => void): () => void;
    [key: string]: unknown;
  }

  export class AgentSessionRuntime {
    session: AgentSession;
    services: AnyRecord;
    diagnostics: unknown[];
    modelFallbackMessage?: string;
    emitBeforeSwitch(reason: string, targetSessionFile?: string): Promise<{ cancelled: boolean }>;
    teardownCurrent(reason: string, targetSessionFile?: string): Promise<void>;
    apply(result: AnyRecord): void;
    finishSessionReplacement(withSession?: (ctx: PiContext) => void | Promise<void>): Promise<void>;
    switchSession(sessionPath: string, options?: AnyRecord): Promise<unknown>;
    [key: string]: unknown;
  }

  export class InteractiveMode {
    defaultEditor?: { onEscape?: () => unknown };
    session?: AgentSession;
    setupKeyHandlers(...args: unknown[]): unknown;
    [key: string]: unknown;
  }

  export class SessionManager {
    flushed?: boolean;
    static create(cwd: string, sessionDir?: string, options?: AnyRecord): PiSessionManager;
    static forkFrom(
      sourcePath: string,
      targetCwd: string,
      sessionDir?: string,
      options?: AnyRecord,
    ): PiSessionManager;
    static list(
      cwd: string,
      sessionDir?: string,
      onProgress?: (loaded: number, total?: number) => void,
    ): Promise<AnyRecord[]>;
    static open(path: string, sessionDir?: string, cwdOverride?: string): PiSessionManager;
  }

  export function createAgentSessionFromServices(options: AnyRecord): Promise<{
    session: AgentSession;
    modelFallbackMessage?: string;
  }>;
  export function createAgentSessionRuntime(
    createRuntime: (options: AnyRecord) => Promise<AnyRecord>,
    options: AnyRecord,
  ): Promise<AgentSessionRuntime>;
  export function createAgentSessionServices(options: AnyRecord): Promise<AnyRecord>;
}
