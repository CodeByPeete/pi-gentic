import type { PiAgentSession, PiApi, PiContext, PiRuntimeSession } from "./types.js";
import type { DelegationId } from "../../domain/identifiers.js";
import { activeDelegationMap, type ActiveDelegation } from "../runtime/DelegationRegistry.js";
import type { SessionTransition } from "./sessions/transitions.js";

/** Dynamic shape exposed by the currently installed Pi host. */
export type HostRecord = Record<string, any>;

export type LiveRuntimeState = {
  liveRuntimes: Map<string, HostRecord>;
  runtimeSessions: Map<string, PiRuntimeSession>;
  activeCalls: ReadonlyMap<DelegationId, ActiveDelegation>;
  sessionTransitions: WeakMap<object, SessionTransition>;
  transitionDispatches: WeakMap<object, SessionTransition>;
  hostDiagnostics: string[];
  hostSwitchSession?: (this: unknown, sessionPath: string, options?: HostRecord) => Promise<unknown>;
  hostNewSession?: (this: unknown, options?: HostRecord) => Promise<unknown>;
  hostForkSession?: (this: unknown, entryId: string, options?: HostRecord) => Promise<unknown>;
  hostImportSession?: (this: unknown, inputPath: string, cwdOverride?: string) => Promise<unknown>;
  hostAbortSession?: (this: unknown, ...args: unknown[]) => Promise<unknown>;
  hostPromptSession?: (this: unknown, ...args: unknown[]) => Promise<unknown>;
  hostSetupKeyHandlers?: (this: unknown, ...args: unknown[]) => unknown;
  hostSetupEditorSubmitHandler?: (this: unknown, ...args: unknown[]) => unknown;
  hostHandleFollowUp?: (this: unknown, ...args: unknown[]) => Promise<unknown>;
  hostRenderCurrentSessionState?: (this: unknown, ...args: unknown[]) => unknown;
  activeContext?: PiContext;
  activeSession?: PiAgentSession;
  activeApi?: PiApi;
  switchSessionInstalled: boolean;
  newSessionInstalled: boolean;
  forkSessionInstalled: boolean;
  importSessionInstalled: boolean;
  sessionAbortInstalled: boolean;
  sessionPromptInstalled: boolean;
  sessionDisposeInstalled: boolean;
  interactiveEscapeInstalled: boolean;
  interactiveSubmitInstalled: boolean;
  interactiveFollowUpInstalled: boolean;
  liveHydrationInstalled: boolean;
};

const LIVE_RUNTIME_STATE_KEY = Symbol.for("pi-gentic.live-runtime-state");

export function getLiveRuntimeState(): LiveRuntimeState {
  const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
  const state = (globalState[LIVE_RUNTIME_STATE_KEY] ??= {
    liveRuntimes: new Map(),
    hostSwitchSession: undefined,
    hostNewSession: undefined,
    hostForkSession: undefined,
    hostImportSession: undefined,
    hostAbortSession: undefined,
    hostPromptSession: undefined,
    hostSetupKeyHandlers: undefined,
    hostSetupEditorSubmitHandler: undefined,
    hostHandleFollowUp: undefined,
    hostRenderCurrentSessionState: undefined,
    activeContext: undefined,
    activeSession: undefined,
    activeApi: undefined,
    switchSessionInstalled: false,
    newSessionInstalled: false,
    forkSessionInstalled: false,
    importSessionInstalled: false,
    sessionAbortInstalled: false,
    sessionPromptInstalled: false,
    sessionDisposeInstalled: false,
    interactiveEscapeInstalled: false,
    interactiveSubmitInstalled: false,
    interactiveFollowUpInstalled: false,
    liveHydrationInstalled: false,
  }) as LiveRuntimeState;

  state.runtimeSessions ??= new Map();
  state.activeCalls = activeDelegationMap();
  state.sessionTransitions ??= new WeakMap();
  state.transitionDispatches ??= new WeakMap();
  state.hostDiagnostics ??= [];

  return state;
}
