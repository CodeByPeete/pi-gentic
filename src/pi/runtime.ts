import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Schema } from "effect";
import type {
  HostRecord,
  PiAgentRuntimeHost,
  PiAgentSession,
  PiApi,
  PiContext,
  PiRuntimeSession,
  PiTheme,
  SessionTransition,
} from "./types.js";

class HostCapabilityUnavailable extends Schema.TaggedErrorClass<HostCapabilityUnavailable>()(
  "HostCapabilityUnavailable",
  { message: Schema.String, capability: Schema.String },
) {}

export type PiCodingAgentPeer = {
  diagnostics?: string[];
  AgentSession: Function & { prototype: PiAgentSession };
  theme?: PiTheme;
  AgentSessionRuntime: { prototype: HostRecord };
  InteractiveMode: { prototype: HostRecord };
  SessionManager?: HostRecord;
  createAgentSessionFromServices: (options: HostRecord) => Promise<{
    session: PiAgentSession;
    modelFallbackMessage?: string;
  }>;
  createAgentSessionRuntime: (
    createRuntime: (options: HostRecord) => Promise<HostRecord>,
    options: HostRecord,
  ) => Promise<PiAgentRuntimeHost>;
  createAgentSessionServices: (options: HostRecord) => Promise<HostRecord>;
};

export type LiveRuntimeState = {
  liveRuntimes: Map<string, HostRecord>;
  runtimeSessions: Map<string, PiRuntimeSession>;
  sessionTransitions: WeakMap<object, SessionTransition>;
  transitionDispatches: WeakMap<object, SessionTransition>;
  hostSessions: WeakMap<object, PiAgentSession>;
  hostMethods: Map<string, Function>;
  hostDiagnostics: string[];
  activeContext?: PiContext;
  activeSession?: PiAgentSession;
  activeApi?: PiApi;
};

const LIVE_RUNTIME_STATE_KEY = Symbol.for("pi-gentic.live-runtime-state");
let peerModule: Promise<PiCodingAgentPeer> | undefined;

export function getLiveRuntimeState(): LiveRuntimeState {
  const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
  const state = (globalState[LIVE_RUNTIME_STATE_KEY] ??= {
    liveRuntimes: new Map(),
    runtimeSessions: new Map(),
    sessionTransitions: new WeakMap(),
    transitionDispatches: new WeakMap(),
    hostSessions: new WeakMap(),
    hostMethods: new Map(),
    hostDiagnostics: [],
  }) as LiveRuntimeState;

  state.runtimeSessions ??= new Map();
  state.sessionTransitions ??= new WeakMap();
  state.transitionDispatches ??= new WeakMap();
  state.hostSessions ??= new WeakMap();
  state.hostMethods ??= new Map();
  state.hostDiagnostics ??= [];
  return state;
}

export function captureHostMethod(state: LiveRuntimeState, key: string, method: unknown) {
  if (state.hostMethods.has(key) || typeof method !== "function") return false;
  state.hostMethods.set(key, method);
  return true;
}

export function callHostMethod(state: LiveRuntimeState, key: string, receiver: HostRecord, args: unknown[]) {
  return state.hostMethods.get(key)?.apply(receiver, args);
}

export function recordHostDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics = getLiveRuntimeState().hostDiagnostics;
  if (!diagnostics.includes(message)) diagnostics.push(message);
}

export async function loadPiCodingAgentPeer(): Promise<PiCodingAgentPeer> {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
  const managedCli = path.join(
    localAppData,
    "pi-managed",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
  const indexFiles = [process.env.PI_CLI, process.argv[1], managedCli]
    .filter(Boolean)
    .map((file) => path.join(path.dirname(String(file)), "index.js"));

  peerModule ??= importFirst([
    ...indexFiles.map((file) => pathToFileURL(file).href),
    "@earendil-works/pi-coding-agent",
  ]);
  return peerModule;
}

async function importFirst(specifiers: string[]): Promise<PiCodingAgentPeer> {
  const errors: unknown[] = [];

  for (const specifier of new Set(specifiers)) {
    try {
      const peer = await import(specifier);
      const resolved = specifier.startsWith("file:") ? specifier : import.meta.resolve(specifier);
      const diagnostics: string[] = [];
      let theme: PiTheme | undefined;

      try {
        const themeModule = await import(new URL("./modes/interactive/theme/theme.js", resolved).href);
        theme = themeModule.theme;
      } catch (error) {
        diagnostics.push(`Could not load the Pi theme: ${String(error)}`);
      }
      return { ...peer, diagnostics, theme } as unknown as PiCodingAgentPeer;
    } catch (error) {
      errors.push(error);
    }
  }
  throw new AggregateError(errors, "Could not load the installed Pi coding-agent runtime.");
}

export function assertPiHostCapabilities(peer: PiCodingAgentPeer) {
  const required: Array<[HostRecord | undefined, string, string]> = [
    [peer.AgentSessionRuntime?.prototype, "switchSession", "AgentSessionRuntime"],
    [peer.AgentSessionRuntime?.prototype, "newSession", "AgentSessionRuntime"],
    [peer.AgentSessionRuntime?.prototype, "fork", "AgentSessionRuntime"],
    [peer.AgentSessionRuntime?.prototype, "importFromJsonl", "AgentSessionRuntime"],
    [peer.AgentSession?.prototype, "bindExtensions", "AgentSession"],
    [peer.AgentSession?.prototype, "abort", "AgentSession"],
    [peer.AgentSession?.prototype, "prompt", "AgentSession"],
    [peer.AgentSession?.prototype, "dispose", "AgentSession"],
    [peer.InteractiveMode?.prototype, "setupEditorSubmitHandler", "InteractiveMode"],
    [peer.InteractiveMode?.prototype, "setupKeyHandlers", "InteractiveMode"],
    [peer.InteractiveMode?.prototype, "handleFollowUp", "InteractiveMode"],
    [peer.InteractiveMode?.prototype, "renderCurrentSessionState", "InteractiveMode"],
  ];
  const missing = required
    .filter(([prototype, method]) => typeof prototype?.[method] !== "function")
    .map(([, method, owner]) => `${owner}.${method}`);

  if (missing.length)
    throw HostCapabilityUnavailable.make({
      message: `The installed Pi host is missing required capabilities: ${missing.join(", ")}.`,
      capability: missing.join(", "),
    });
}
