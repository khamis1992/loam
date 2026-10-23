import type { AskUserQuestion } from "../tools/askUserStore.js";

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

/**
 * Live status of one step of an incremental Recipe (N4).
 *
 * `proposed` is a step the planner has put forward but the engine has not started
 * yet; `ready` is a step whose turn has come and which is executable. `doing`,
 * `done`, `blocked` and `skipped` match the run-graph node lifecycle so a recipe
 * row and its canvas node never disagree about the same step.
 */
export type RecipeStepStatus = "proposed" | "ready" | "doing" | "done" | "blocked" | "skipped";

/** How a recipe changed since the previous `recipe_update` event. */
export type RecipeChange = "init" | "propose" | "advance" | "rewrite" | "drop" | "restart";

/** One step of an incremental Recipe, as carried by `recipe_update`. */
export interface RecipeStepInfo {
  id: string;
  title: string;
  instruction: string;
  successCriteria: string;
  status: RecipeStepStatus;
  /** Run-graph node id this step maps to; undefined while it is only proposed. */
  nodeId?: string;
  /** Recipe step ids this step replaced, when the planner rewrote them. */
  replaces?: string[];
  /** Recipe steps finished so far (never counts the current step). */
  completedCount: number;
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
  | { type: "tool_result"; name: string; ok: boolean; summary: string; ms?: number; kbSeedIds?: string[]; kbSeeds?: Array<{ id: string; title: string; tags: string[]; preview: string }> }
  | { type: "done"; text: string; steps: number; model: string }
  | { type: "cancelled" }
  | { type: "error"; message: string }
  /** Frontier mode auto-detection: the operational mode activated for this task (app-build, mobile-dev, ...). */
  | { type: "mode"; mode: string; label: string; labelAr: string; reason?: string }
  /** Companion gateway: the work mode activated for this run (chat, loam, user_device, ...) and its device requirement. */
  | { type: "workmode"; workMode: string; labelAr: string; deviceRequired: boolean; deviceId?: string; deviceName?: string; reason?: string }
  /** Orchestrator: the full execution plan for this task. */
  | { type: "plan"; goal: string; trivial: boolean; steps: PlanStepInfo[]; source: "model" | "fallback" }
  /**
   * Neo N4 incremental Recipe engine: the live step list of a recipe-mode run.
   *
   * Emitted whenever the recipe changes: at the start, after a step's result
   * (when the planner proposes the next step(s)), and after a restart. Unlike
   * `plan`, which describes the plan as it was at the start, this event carries
   * the *current* ordered recipe with the per-step status the canvas renders, so
   * the remaining work is visible and shrinks as the run proceeds.
   */
  | {
      type: "recipe_update";
      goal: string;
      steps: RecipeStepInfo[];
      /** Estimated number of recipe steps still to run, current step included. */
      remainingEstimate: number;
      /** How the recipe changed since the previous `recipe_update`. */
      change: RecipeChange;
      /** Who produced the change; "auto" is a local engine adjustment. */
      source: "planner" | "restart" | "auto";
    }
  /**
   * Neo N4: the recipe restarted from one step.
   *
   * Everything downstream of `stepId` is regenerated; the outputs of the steps
   * before it are kept verbatim, which is why the event names the node it keeps.
   */
  | {
      type: "recipe_restart";
      /** Recipe step id the restart begins at. */
      stepId: string;
      /** Run-graph node id the restart begins at (same step). */
      nodeId: string;
      /** Recipe step ids kept verbatim (everything before the restart point). */
      keptSteps: string[];
      /** Recipe step ids regenerated from the restart point onwards. */
      regeneratedSteps: string[];
      reason: string;
    }
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
  /** Pending ask-user clarification (N9): a `ask_user` request awaits the user's answer. */
  | { type: "ask_user_required"; askUserId: string; taskId: string; tool: string; title: string; reason: string; questions: AskUserQuestion[]; source?: import("../tools/askUserStore.js").AskUserSource; reasonCode?: import("../tools/askUserStore.js").AskUserReasonCode }
  /** Plan mode: the task's local permission mode changed (plan_exit approval, user switch). */
  | { type: "permission_mode_changed"; mode: import("../policy/permissionModes.js").LocalPermissionMode; previousMode: import("../policy/permissionModes.js").LocalPermissionMode; reason: string }
  /** End-to-end verification of the completed task. */
  | { type: "verify"; verdict: Verdict; reason: string; parsed?: boolean }
  /** Context compression happened. step 3 is the synchronous emergency hard-compact
   *  (no summarizer call); `blocked` marks the case where a PreCompact hook vetoed
   *  the compaction and nothing was compressed. */
  | { type: "compaction"; step: 1 | 2 | 3; originalTokens: number; afterPruneTokens: number; finalTokens: number; summaryChars?: number; fallback?: boolean; emergency?: boolean; droppedTurns?: number; blocked?: boolean }
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
   * Neo N5: the per-step context selector re-shaped the transcript for this
   * step. `tokens` is the estimated size of the selected blocks, `artefacts`
   * the number of artefacts in the run's store, and `reason` why the selector
   * applied (or why it declined).
   */
  | { type: "context_selected"; step: number; tokens: number; artefacts: number; reason: string }
  /**
   * Neo N6: a mission reached its budget ceiling and stopped *cleanly*.
   *
   * This is not a failure: the mission ran until the limit the user set. The
   * canvas renders it as a summary node so the run shows where it got to and
   * what it consumed instead of an error banner.
   */
  | {
      type: "budget_exhausted";
      taskId: string;
      /** Why the budget stopped the mission (steps/tokens/wall-clock/cost). */
      reason: string;
      /** The checkpoint at the stop, carried so the summary is truthful. */
      checkpoint: import("./mission.js").MissionCheckpoint;
    }
  /**
   * fc-06: a Loam Video export is in flight. Live-only (no canvas node): the
   * rendered file lands in the task workspace when the stage reaches "saving".
   */
  | { type: "video_studio_export"; taskId: string; stage: "starting" | "rendering" | "saving"; progress?: number }
  /**
   * MiroFish swarm simulation progress. Carries one `SimulationProgressEvent`
   * from the M3 loop as `payload` (the tool module owns that type; the agent core
   * deliberately does not import a tool module).
   */
  | { type: "simulation_progress"; sessionId: string; payload: unknown }
  /**
   * Loam Video Studio relay: one command for the panel attached to this task's
   * event stream. The panel executes it with its editor bridge and posts the
   * result back to /api/tasks/:id/video-studio/result.
   */
  | { type: "video_studio_command"; id: string; target: "film" | "effects"; method: string; params: Record<string, unknown> }
  /**
   * Workspace relay: one command for the editor panel attached to this task's
   * event stream. The panel executes it with its editor bridge and posts the
   * result back to /api/tasks/:id/workspace/result.
   *
   * It carries both the Video Studio targets (film/effects) and the Craft app
   * targets (docs/sheets/slides/photo/design); `craft.open` and `craft.waitSave`
   * are pseudo-methods the panel handles itself. See src/server/workspaceRelay.ts.
   */
  | {
      type: "workspace_command";
      id: string;
      target: "film" | "effects" | "docs" | "sheets" | "slides" | "photo" | "design";
      method: string;
      params: Record<string, unknown>;
    }
  /**
   * No editor panel was attached for this task+target, so the relay asked the
   * shell to open the right panel (cr-03) before the caller retries.
   */
  | {
      type: "workspace_open_request";
      target: "film" | "effects" | "docs" | "sheets" | "slides" | "photo" | "design";
      path: string | null;
    }
  /**
   * N7 branch fan-out: one independent branch of a fan-out started or finished.
   *
   * A branch is a whole subtree of its own, so it gets its own canvas node off
   * the parent step instead of one node per tool call inside the child.
   */
  | {
      type: "fanout_branch";
      /** Stable id of the fan-out this branch belongs to. */
      fanoutId: string;
      /** Zero-based branch index within the fan-out. */
      index: number;
      phase: "start" | "done";
      /** Run-graph node id of the branch root (also present on `done`). */
      nodeId?: string;
      /** Branch label (the prompt or model this branch ran). */
      label?: string;
      /** Short summary of what the branch produced, on `done`. */
      summary?: string;
      /** True when the branch produced a usable result; the canvas marks the node failed otherwise. */
      ok?: boolean;
    }
  /** N7 branch fan-out: the merge step consumed every branch of a fan-out. */
  | {
      type: "fanout_merge";
      fanoutId: string;
      /** Run-graph node ids of every branch this merge consumed. */
      branchNodeIds: string[];
      /** The merged result. */
      summary: string;
    };

export type Emit = (event: AgentEvent) => void;
