export type Verdict = "pass" | "revise" | "fail";

export interface VerdictInfo {
  verdict: Verdict;
  reason: string;
  fixes: string[];
}

export interface PlanStepInfo {
  id: string;
  title: string;
  instruction: string;
  successCriteria: string;
}

export interface ToolTraceItem {
  name: string;
  ok: boolean;
  summary: string;
  ms?: number;
  /** Tool arguments (so the reviewer can see the exact commands/probes used). */
  args?: unknown;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export type AgentEvent =
  | { type: "verification_progress"; stage: "creative" | "application" | "independent_author" | "independent_application" | "final_review" }
  | { type: "task-status"; status: string }
  | { type: "task"; taskId: string }
  | { type: "step"; index: number }
  | { type: "assistant_token"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; ok: boolean; summary: string; ms?: number }
  | { type: "done"; text: string; steps: number; model: string }
  | { type: "cancelled" }
  | { type: "error"; message: string }
  /** Frontier mode auto-detection: the operational mode activated for this task (app-build, mobile-dev, ...). */
  | { type: "mode"; mode: string; label: string; labelAr: string; reason?: string }
  /** Companion gateway: the work mode activated for this run (chat, loam, user_device, ...) and its device requirement. */
  | { type: "workmode"; workMode: string; labelAr: string; deviceRequired: boolean; deviceId?: string; deviceName?: string; reason?: string }
  /** Orchestrator: the full execution plan for this task. */
  | { type: "plan"; goal: string; trivial: boolean; steps: PlanStepInfo[]; source: "model" | "fallback" }
  /** Orchestrator: lifecycle of one plan step (executor worker run). */
  | { type: "plan_step"; id: string; index: number; total: number; title: string; phase: "start" | "done"; summary?: string }
  /** Verifier verdict on one plan step (Actor-Critic: critique). */
  | { type: "critique"; id: string; verdict: Verdict; reason: string; parsed?: boolean }
  /** Reflection loop: the step is being retried with the critique's fixes. */
  | { type: "revise"; id: string; attempt: number; fixes: string[] }
  /** Reflection loop: the plan is being rebuilt after a "fail" verdict. */
  | { type: "replan"; round: number; reason: string }
  /** Sensitive-action gate: a host input action awaits an explicit user decision. */
  | { type: "approval_required"; approvalId: string; tool: string; summary: string }
  /** Environment-issue report: a step cannot run because of the local environment. */
  | { type: "environment_issue"; message: string; details?: string }
  /** End-to-end verification of the completed task. */
  | { type: "verify"; verdict: Verdict; reason: string; parsed?: boolean };

export type Emit = (event: AgentEvent) => void;
