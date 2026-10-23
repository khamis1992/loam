export type Verdict = "pass" | "revise" | "fail";

export interface VerdictInfo {
  verdict: Verdict;
  reason: string;
  fixes: string[];
}

/** Live status of one plan step. Defaults are derived from the step index. */
export type PlanStepStatus = "pending" | "doing" | "done" | "blocked" | "cancelled";

/** Live status of one todo item. Exactly one item may be `in_progress`. */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** One item in the model's live task list, maintained with `todo_write`. */
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/** Coarse work phase of a task, set explicitly via the phase_set tool. */
export type WorkPhase = "chat" | "plan" | "build" | "verify";

export interface PlanStepInfo {
  id: string;
  title: string;
  instruction: string;
  successCriteria: string;
  /** Explicit status supplied by the plan tool; otherwise derived from the index. */
  status?: PlanStepStatus;
  /** Optional note; required by validation when status is blocked or cancelled. */
  note?: string;
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
  /**
   * Tokens the provider reported as served from its prompt cache. Undefined when
   * the provider reports no cache telemetry, which is never treated as a miss.
   */
  cachedTokens?: number;
  /** Tokens written into the cache on this request, when reported. */
  cacheWriteTokens?: number;
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
  /** The model's live task list, replaced in full by the `todo_write` tool. */
  | { type: "todo"; todos: TodoItem[]; source: "model" }
  /** Work phase of the current task, set explicitly via the phase_set tool. */
  | { type: "phase"; phase: WorkPhase; reason: string }
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
  /** Pending plan approval (D4): a `suggest_plan` plan awaits the user's decision. */
  | { type: "plan_approval_required"; planApprovalId: string; taskId: string; tool: string; summary: string; steps: string[]; filesToEdit: string[]; trivial: boolean }
  /** Plan mode: the task's local permission mode changed (plan_exit approval, user switch). */
  | { type: "permission_mode_changed"; mode: import("../policy/permissionModes.js").LocalPermissionMode; previousMode: import("../policy/permissionModes.js").LocalPermissionMode; reason: string }
  /** End-to-end verification of the completed task. */
  | { type: "verify"; verdict: Verdict; reason: string; parsed?: boolean }
  /** Context compression happened. */
  | { type: "compaction"; step: 1 | 2; originalTokens: number; afterPruneTokens: number; finalTokens: number; summaryChars?: number; fallback?: boolean; blocked?: boolean }
  /**
   * Prompt-cache (KV cache) accounting. Emitted on every completed provider
   * request that reported cache telemetry, so clients can show reusable-token
   * counters and a cold-cache notice.
   */
  | {
      type: "cache_usage";
      provider: string;
      model: string;
      promptTokens: number;
      cachedTokens: number;
      /** Present only when the provider reported a real miss/refresh. */
      miss?: {
        reason: string;
        expectedTokens: number;
        readTokens: number;
        missedTokens: number;
        documentedCause?: string;
        message: string;
      };
    }
  /** A workspace file was published as a task artifact via artifact_publish. */
  | { type: "artifact_published"; path: string; kind: string; title: string; mime: string; sizeBytes: number; sha256: string }
  /**
   * Loam Video Studio relay: one command for the panel attached to this task's
   * event stream. The panel executes it with its editor bridge and posts the
   * result back to /api/tasks/:id/video-studio/result.
   */
  | { type: "video_studio_command"; id: string; target: "film" | "effects"; method: string; params: Record<string, unknown> };

export type Emit = (event: AgentEvent) => void;
