import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HostCapabilityUnavailable } from "../../domain/errors.js";
import type { PiAgentRuntimeHost, PiAgentSession, PiTheme } from "./types.js";
import type { HostRecord } from "./state.js";

export type PiCodingAgentPeer = {
  diagnostics?: string[];
  AgentSession: { prototype: HostRecord };
  theme?: PiTheme;
  AgentSessionRuntime: { prototype: HostRecord };
  InteractiveMode?: { prototype?: HostRecord };
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

let peerModule: Promise<PiCodingAgentPeer> | undefined;

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

      return {
        ...peer,
        diagnostics,
        theme,
      } as unknown as PiCodingAgentPeer;
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

  if (missing.length > 0)
    throw HostCapabilityUnavailable.make({
      message: `The installed Pi host is missing required capabilities: ${missing.join(", ")}.`,
      capability: missing.join(", "),
    });
}
