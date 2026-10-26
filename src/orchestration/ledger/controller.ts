/**
 * C1 glue the orchestrator calls (agent/orchestrator.ts). One controller per
 * run. The orchestrator feeds it one TurnRecord per worker model turn and
 * acts on the returned decision:
 *   continue -> keep going; pass `instruction` to the worker as a hint
 *   replan   -> run the existing replan round with rootCauseReplanNote()
 *               appended to replanPrompt
 *   finish   -> stop the worker and go to verification (verifyFinal stays on)
 *   escalate -> open a `stalled_replan` interrupt and wait for the user
 * A ledger failure or a missing cloud model never stops the run: the
 * controller degrades to the syntactic detector + Loam's existing stallGuard.
 */
import type { OrchestrationConfig } from "../config.js";
import type { OrchestrationEvent, LedgerDecision } from "../events.js";
import type { ModelPort } from "../modelPort.js";
import { detectStuck, type TurnRecord } from "./stuckPatterns.js";
import { EMPTY_LEDGER, rootCauseReplanNote, runLedgerTurn, shouldRunLedger, type LedgerContext, type LedgerState } from "./progressLedger.js";

export interface LedgerControllerDeps {
  cfg: OrchestrationConfig;
  repairAttempts: number;
  port: ModelPort;
  /** Resolved cloud model, or undefined when none is configured (degraded mode). */
  model: string | undefined;
  emit: (ev: OrchestrationEvent) => void;
  context: () => Omit<LedgerContext, "stuckHint">;
  restored?: LedgerState;
  signal?: AbortSignal;
}

export interface LedgerOutcome {
  decision: LedgerDecision;
  reason: string;
  instruction?: string;
  replanNote?: string;
  tokens: number;
}

export interface LedgerController {
  observe(turn: TurnRecord): Promise<LedgerOutcome>;
  state(): LedgerState;
}

export function createLedgerController(d: LedgerControllerDeps): LedgerController {
  let st: LedgerState = d.restored ?? structuredClone(EMPTY_LEDGER);
  const turns: TurnRecord[] = [];
  let sinceLast = 0;
  let degradedNotified = false;
  return {
    state: () => st,
    async observe(turn) {
      turns.push(turn);
      if (turns.length > 20) turns.shift();
      sinceLast++;
      const stuck = detectStuck(turns);
      if (stuck) d.emit({ type: "stall_detected", pattern: stuck.pattern, detail: stuck.detail });
      if (!d.cfg.ledger.enabled) return { decision: "continue", reason: "ledger disabled", tokens: 0 };
      if (!d.model) {
        if (!degradedNotified) {
          degradedNotified = true;
          d.emit({ type: "core_degraded", feature: "progress_ledger", reason: "no cloud model configured" });
        }
        // Syntactic-only fallback: a detected loop counts as a stall.
        const stallCount = stuck ? st.stallCount + 1 : Math.max(0, st.stallCount - 1);
        st = { ...st, stallCount, turns: st.turns + 1 };
        if (stallCount > d.cfg.ledger.maxStallCount) {
          if (st.resetCount >= d.cfg.ledger.maxResets) return { decision: "escalate", reason: stuck?.detail ?? "stalled", tokens: 0 };
          st = { ...st, stallCount: 0, resetCount: st.resetCount + 1 };
          return { decision: "replan", reason: stuck?.detail ?? "stalled", replanNote: rootCauseReplanNote(st, stuck?.detail ?? "stalled"), tokens: 0 };
        }
        return { decision: "continue", reason: "syntactic check only", tokens: 0 };
      }
      if (!shouldRunLedger(sinceLast, d.cfg.ledger.everyTurns, !!stuck)) return { decision: "continue", reason: "ledger not due", tokens: 0 };
      sinceLast = 0;
      const out = await runLedgerTurn({
        port: d.port,
        model: d.model,
        ctx: { ...d.context(), stuckHint: stuck ? `${stuck.pattern}: ${stuck.detail}` : undefined },
        state: st,
        limits: { maxStallCount: d.cfg.ledger.maxStallCount, maxResets: d.cfg.ledger.maxResets },
        maxChars: d.cfg.ledger.maxLedgerChars,
        repairAttempts: d.repairAttempts,
        signal: d.signal,
      });
      if (!out.ok) {
        d.emit({ type: "contract_failed", contract: "progress_ledger", error: out.error, attempts: d.repairAttempts + 1 });
        return { decision: "continue", reason: "ledger unavailable this turn", tokens: out.tokens };
      }
      const prevResets = st.resetCount;
      st = out.state;
      d.emit({
        type: "ledger",
        round: st.resetCount,
        turn: st.turns,
        stallCount: st.stallCount,
        decision: out.decision,
        reason: out.reason,
        isSatisfied: out.entry.satisfied.value,
        isProgressing: out.entry.progressing.value,
        isInLoop: out.entry.inLoop.value,
        instruction: out.entry.instruction,
      });
      if (out.decision === "replan" && st.resetCount > prevResets) {
        d.emit({ type: "replan_reset", resetCount: st.resetCount, reason: out.reason, newFacts: st.facts.length });
        return { decision: "replan", reason: out.reason, replanNote: rootCauseReplanNote(st, out.reason), tokens: out.tokens };
      }
      return { decision: out.decision, reason: out.reason, instruction: out.entry.instruction, tokens: out.tokens };
    },
  };
}
