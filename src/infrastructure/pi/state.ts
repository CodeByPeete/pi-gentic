import type { DelegationId } from "../../domain/identifiers.js";
import { activeDelegationMap, type ActiveDelegation } from "../runtime/DelegationRegistry.js";
import type { PiAgentSession, PiApi, PiContext, PiRuntimeSession } from "./types.js";
import type { SessionTransition } from "./sessions/transitions.js";

/** Dynamic shape exposed by the currently installed Pi host. */
export type HostRecord = Record<string, any>;
type HostMethod = Function;

export type LiveRuntimeState = {
  liveRuntimes: Map<string, HostRecord>;
  runtimeSessions: Map<string, PiRuntimeSession>;
  activeCalls: ReadonlyMap<DelegationId, ActiveDelegation>;
  sessionTransitions: WeakMap<object, SessionTransition>;
  transitionDispatches: WeakMap<object, SessionTransition>;
  hostMethods: Map<string, HostMethod>;
  hostDiagnostics: string[];
  activeContext?: PiContext;
  activeSession?: PiAgentSession;
  activeApi?: PiApi;
};

const LIVE_RUNTIME_STATE_KEY = Symbol.for("pi-gentic.live-runtime-state");

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

export function getLiveRuntimeState(): LiveRuntimeState {
  const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
  const state = (globalState[LIVE_RUNTIME_STATE_KEY] ??= {
    liveRuntimes: new Map(),
    hostMethods: new Map(),
    activeContext: undefined,
    activeSession: undefined,
    activeApi: undefined,
  }) as LiveRuntimeState;

  state.runtimeSessions ??= new Map();
  state.activeCalls = activeDelegationMap();
  state.sessionTransitions ??= new WeakMap();
  state.transitionDispatches ??= new WeakMap();
  state.hostMethods ??= new Map();
  state.hostDiagnostics ??= [];

  return state;
}
