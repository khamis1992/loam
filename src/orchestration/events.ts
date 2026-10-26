/**
 * New AgentEvent members (added to the union in src/agent/events.ts).
 * snake_case `type` values match Loam's existing AgentEvent style.
 */
export type LedgerDecision = "continue" | "replan" | "finish" | "escalate";

// Structural copies of the three interrupt enum types (durable/interrupts.ts
// is the owner; these aliases keep events.ts dependency-free in wave order).
export type InterruptKind = "ask_user" | "plan_approval" | "tool_approval" | "acp_permission" | "stalled_replan" | "workflow_human" | "custom";
export type InterruptStatus = "pending" | "resolved" | "dismissed" | "expired" | "cancelled";
export type ResolvedBy = "user" | "auto" | "policy" | "timeout";

export type OrchestrationEvent =
  | { type: "trace_started"; traceId: string; traceparent: string }
  | { type: "checkpoint_saved"; checkpointId: string; round: number; nextStep: number; branchId: string }
  | { type: "interrupt_requested"; interruptId: string; kind: InterruptKind; expiresAt: number }
  | { type: "interrupt_resolved"; interruptId: string; kind: InterruptKind; status: InterruptStatus; resolvedBy: ResolvedBy | null }
  | {
      type: "ledger";
      round: number;
      turn: number;
      stallCount: number;
      decision: LedgerDecision;
      reason: string;
      isSatisfied: boolean;
      isProgressing: boolean;
      isInLoop: boolean;
      instruction: string;
    }
  | { type: "stall_detected"; pattern: string; detail: string }
  | { type: "replan_reset"; resetCount: number; reason: string; newFacts: number }
  | { type: "selection"; selectionId: string; candidates: number; pruned: number; groups: number; winnerId: string | null; method: "single" | "regression" | "majority" | "judge" | "first" | "none" }
  | { type: "contract_failed"; contract: string; error: string; attempts: number }
  | { type: "guard_flagged"; tool: string; score: number; signals: string[]; action: "warn" | "filter" | "block" }
  | { type: "core_degraded"; feature: string; reason: string }
  | { type: "acp_models"; agent: string; current: string | null; available: string[] }
  | { type: "return_direct"; tool: string; chars: number }
  | { type: "workflow_node"; runId: string; nodeId: string; status: "started" | "succeeded" | "failed" | "skipped" | "waiting"; superstep: number };
