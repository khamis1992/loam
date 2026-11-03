/**
 * C1 (cheap tier): syntactic stuck detection over the last 20 worker turns.
 * Pattern set and thresholds follow OpenHands SDK StuckDetector
 * (conversation/stuck_detector.py, types.py:150: action-observation 4,
 * action-error 3, monologue 3, alternating 6, window 20). Own implementation.
 * OpenHands leaves context-window loops as a TODO (stuck_detector.py:314);
 * Loam detects them from compaction failures (threshold 2).
 *
 * Loam today: agent/stallGuard.ts counts consecutive identical or failed
 * tool calls only. This module adds monologue, alternating and context loops
 * and feeds the progress ledger instead of only injecting STALL_NOTICE.
 */
export interface TurnRecord {
  /** `${tool}:${stable JSON args}` per tool call, in call order. Empty = text-only turn. */
  actions: string[];
  /** Normalized result per call: `ok:<sha of first 2000 chars>` or `err:<first 200 chars>`. */
  observations: string[];
  /** Assistant text of the turn, trimmed. */
  text: string;
  /** The turn ended with a context-overflow compaction that did not shrink enough. */
  contextOverflow?: boolean;
}

export type StuckPattern = "repeat_action_observation" | "repeat_action_error" | "monologue" | "alternating" | "context_loop";

export const STUCK_THRESHOLDS = {
  window: 20,
  actionObservation: 4,
  actionError: 3,
  monologue: 3,
  alternating: 6,
  contextLoop: 2,
} as const;

export interface StuckFinding {
  pattern: StuckPattern;
  detail: string;
}

const key = (t: TurnRecord) => `${t.actions.join("|")}=>${t.observations.join("|")}`;

export function detectStuck(turns: readonly TurnRecord[], th = STUCK_THRESHOLDS): StuckFinding | undefined {
  const w = turns.slice(-th.window);
  const tail = (n: number) => (w.length >= n ? w.slice(-n) : undefined);

  const ctx = tail(th.contextLoop);
  if (ctx && ctx.every((t) => t.contextOverflow)) return { pattern: "context_loop", detail: `${th.contextLoop} context overflows in a row` };

  const ae = tail(th.actionError);
  if (ae && ae[0] && ae[0].actions.length > 0 && ae.every((t) => key(t) === key(ae[0] as TurnRecord) && t.observations.some((o) => o.startsWith("err:")))) {
    return { pattern: "repeat_action_error", detail: `${ae[0].actions.join(", ")} failed ${th.actionError} times with the same error` };
  }

  const ao = tail(th.actionObservation);
  if (ao && ao[0] && ao[0].actions.length > 0 && ao.every((t) => key(t) === key(ao[0] as TurnRecord))) {
    return { pattern: "repeat_action_observation", detail: `${ao[0].actions.join(", ")} repeated ${th.actionObservation} times with the same result` };
  }

  const mono = tail(th.monologue);
  if (mono && mono[0] && mono.every((t) => t.actions.length === 0 && t.text.length > 0 && t.text === (mono[0] as TurnRecord).text)) {
    return { pattern: "monologue", detail: `same text-only reply ${th.monologue} times` };
  }

  const alt = tail(th.alternating);
  if (alt && alt.length === th.alternating) {
    const a = key(alt[0] as TurnRecord);
    const b = key(alt[1] as TurnRecord);
    if (a !== b && alt.every((t, i) => key(t) === (i % 2 === 0 ? a : b))) {
      return { pattern: "alternating", detail: `two actions alternated ${th.alternating / 2} times each` };
    }
  }
  return undefined;
}
