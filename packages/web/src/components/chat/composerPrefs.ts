/**
 * Composer preferences + intent routing (Phase UX-W2 «صندوق واحد»).
 *
 * - Prefs: the advanced controls' choices persist in localStorage so the user
 *   sets them once; the composer initializes from them on mount.
 * - Auto mode: when on (default), a send without an explicit Loam mode first
 *   asks the server's intent router (POST /api/intent/route) to pick the mode
 *   and returns an Arabic one-line explanation for the composer chip.
 */

import { getApiBase, getLoamAuthHeaders } from '@/services/rpc';

const PREFS_KEY = 'loam.composer.prefs';
const ADVANCED_OPEN_KEY = 'loam.composer.advancedOpen';

export interface ComposerPrefs {
  autoMode?: boolean;
  tier?: 'standard' | 'lite' | 'max';
  outputType?: string;
  effort?: string;
  compareModels?: boolean;
}

export function getComposerPrefs(): ComposerPrefs {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ComposerPrefs;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function setComposerPrefs(patch: Partial<ComposerPrefs>): void {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...getComposerPrefs(), ...patch };
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — prefs stay session-only */
  }
}

export function getAdvancedOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ADVANCED_OPEN_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setAdvancedOpen(open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ADVANCED_OPEN_KEY, open ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

export interface IntentRouteResult {
  mode: string;
  reason: string;
  source: 'model' | 'keywords';
}

/** Ask the server's intent router to pick the Loam mode for this brief.
 *  Returns null on any failure — the caller sends with its default mode. */
export async function routeIntentApi(text: string): Promise<IntentRouteResult | null> {
  try {
    const response = await fetch(`${getApiBase()}/api/intent/route`, {
      method: 'POST',
      headers: { ...(await getLoamAuthHeaders()), 'content-type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { mode?: unknown; reason?: unknown; source?: unknown };
    if (typeof body?.mode !== 'string' || !body.mode) return null;
    return {
      mode: body.mode,
      reason: typeof body.reason === 'string' ? body.reason : '',
      source: body.source === 'model' ? 'model' : 'keywords',
    };
  } catch {
    return null;
  }
}
