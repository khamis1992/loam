/**
 * J7 renderer hibernation test hook.
 *
 * Adapted from jcode (MIT) ref/SESSION_HIBERNATION.md: hibernation has to be
 * *observable* before it can be trusted. The hook exposes a tiny, explicitly
 * namespaced surface on `window` so the e2e suite and the renderer-RSS bench can
 * drive a real hibernate/wake without waiting 30 minutes, and can inject
 * canonical events into the store so a large transcript can be rendered first.
 *
 * The surface only ever reads and writes renderer-local derived state plus the
 * Redux store. It never talks to the daemon: waking is a state change, not a
 * network call, which is what makes the "first keystroke does not lose the
 * typed character" property testable in a renderer-only harness.
 */
'use client';

import { appendEvent, setError } from '@/store/chatSlice';
import {
  buildDerivedChatState,
  getDerivedChatState,
  releaseDerivedChatState,
  resetDerivedChatState,
  setDerivedChatState,
} from './hibernationStore';
import type { ChatEvent } from '@shared/socket';

export interface HibernationHookState {
  sessionId: string | null;
  hibernated: boolean;
  /** True when the hook itself is attached (the view mounted it). */
  available: boolean;
}

export interface HibernationHookController {
  /** True once the hook has attached to the page. */
  isAvailable(): boolean;
  /** Resolve once the hook has attached (no-op if already attached). */
  ready(): Promise<void>;
  /** Current renderer-local state for one session. */
  getState(sessionId?: string): HibernationHookState;
  /** Inject canonical events into the store and build the derived fold. */
  injectEvents(sessionId: string, events: readonly ChatEvent[]): void;
  /** Release the derived render state now (bypasses the idle clock). */
  hibernate(sessionId: string): Promise<{ released: boolean; entries: number; bytes: number }>;
  /** Wake a hibernated session. */
  wake(sessionId: string): Promise<void>;
  /** Drop every session's derived state (test teardown). */
  reset(): void;
}

declare global {
  interface Window {
    __loamHibernation?: HibernationHookController & { __attached?: boolean };
  }
}

/** The session the hook last acted on (used when a caller passes no id). */
let currentSessionRef: string | null = null;

/** Pending `ready()` resolvers, released when the view attaches the hook. */
const READY_RESOLVERS = new Set<() => void>();

function attachedHook(): (HibernationHookController & { __attached?: boolean }) | undefined {
  return typeof window === 'undefined' ? undefined : window.__loamHibernation;
}

/** True when a mounted chat view has attached the hook. */
export function isHibernationHookAvailable(): boolean {
  return Boolean(attachedHook()?.__attached);
}

/** Resolve every pending `ready()` once the view attaches the hook. */
export function resolveHibernationReady(): void {
  for (const resolve of READY_RESOLVERS) resolve();
  READY_RESOLVERS.clear();
}

export interface HibernationHookDeps {
  /** Dispatch into the app store (the view passes its own `dispatch`). */
  dispatch: (action: unknown) => void;
  /** Read the renderer-local hibernated flag for a session. */
  isHibernated: (sessionId: string) => boolean;
  /** Set the renderer-local hibernated flag for a session. */
  setHibernated: (sessionId: string, value: boolean) => void;
  /**
   * Ask the daemon to hibernate. Optional: a renderer-only harness (vitest,
   * the RSS bench) exercises the same code path without a server, and a daemon
   * refusal is surfaced as a store error rather than a silent local release.
   */
  hibernateDaemon?: (sessionId: string) => Promise<void>;
  /** Ask the daemon to wake. Optional for the same reason. */
  wakeDaemon?: (sessionId: string) => Promise<void>;
}

/**
 * Build the controller a mounted chat view registers on `window`. The view owns
 * the hibernated flag and the dispatch function, so the hook cannot drift from
 * what the UI actually shows.
 */
export function createHibernationTestHook(deps: HibernationHookDeps): HibernationHookController & { __attached?: boolean } {
  const { dispatch, isHibernated, setHibernated } = deps;
  const hibernateDaemon = deps.hibernateDaemon ?? (async () => undefined);
  const wakeDaemon = deps.wakeDaemon ?? (async () => undefined);

  const controller: HibernationHookController & { __attached?: boolean } = {
    __attached: true,
    isAvailable() {
      return true;
    },
    ready() {
      if (isHibernationHookAvailable()) return Promise.resolve();
      return new Promise<void>((resolve) => READY_RESOLVERS.add(resolve));
    },
    getState(sessionId?: string): HibernationHookState {
      const target = sessionId ?? currentSessionRef;
      return {
        sessionId: target,
        hibernated: target ? isHibernated(target) : false,
        available: true,
      };
    },
    injectEvents(sessionId: string, events: readonly ChatEvent[]) {
      currentSessionRef = sessionId;
      for (const event of events) dispatch(appendEvent({ sessionId, event }));
      // Build the same derived fold the view builds, so a release can account
      // for it and a wake can rebuild it from the canonical events.
      setDerivedChatState(buildDerivedChatState(sessionId, events));
    },
    async hibernate(sessionId: string) {
      currentSessionRef = sessionId;
      try {
        await hibernateDaemon(sessionId);
      } catch (error) {
        // A daemon refusal (an in-flight tool/agent turn) must not leave the
        // renderer believing it released state, so surface it instead.
        dispatch(setError({ sessionId, error: error instanceof Error ? error.message : String(error) }));
        throw error;
      }
      const released = releaseDerivedChatState(sessionId);
      setHibernated(sessionId, true);
      return { released: released.released, entries: released.entries, bytes: released.bytes };
    },
    async wake(sessionId: string) {
      currentSessionRef = sessionId;
      await wakeDaemon(sessionId);
      setHibernated(sessionId, false);
      // The canonical events are already in the store; rebuild the fold so the
      // transcript repaints immediately on wake.
      const state = getDerivedChatState(sessionId);
      if (state) setDerivedChatState(state);
    },
    reset() {
      resetDerivedChatState();
      currentSessionRef = null;
    },
  };

  return controller;
}
