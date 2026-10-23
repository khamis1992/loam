/** Local event shapes consumed by the approval components.
 *  `LocalExecutionApprovalRequested` reuses the shared wire type added for
 *  option 14 (packages/shared/src/socket.ts); `FolderAccessRequestEvent`
 *  matches @shared/socket structurally and stays local for convenience.
 */
import type { LocalExecutionApprovalRequestedEvent } from "@shared/socket";

export type LocalExecutionApprovalRequested = LocalExecutionApprovalRequestedEvent;

/** D4: a `suggest_plan` plan awaiting the user's decision. */
export interface PlanApprovalRequested {
  type: "planApprovalRequested";
  id: string;
  timestamp: number;
  requestId: string;
  taskId: string;
  summary: string;
  steps: string[];
  filesToEdit: string[];
  trivial: boolean;
}

/** N9: an `ask_user` clarification awaiting the user's answer. */
export interface AskUserRequested {
  type: "askUserRequested";
  id: string;
  timestamp: number;
  requestId: string;
  taskId: string;
  title: string;
  reason: string;
  questions: Array<{ id: string; prompt: string; options?: string[]; allowFile?: boolean }>;
  /** "auto" is the orchestrator's vague/missing-context trigger; "model" a tool call. */
  source?: "auto" | "model";
  /** Set when `source` is "auto"; the card localizes the reason from it. */
  reasonCode?: "vague" | "missing_context" | "ambiguous_target";
}

export interface FolderAccessRequestEvent {
  type: "folderAccessRequest";
  id: string;
  timestamp: number;
  requestId: string;
  path: string;
  access: "read" | "write";
}

export type LocalPermissionMode = "ask_for_approval" | "approve_for_me" | "full_access";

export interface PermissionModeInfo {
  mode: LocalPermissionMode;
  title: string;
  titleAr: string;
  description: string;
  descriptionAr: string;
  icon: "hand" | "shield-check" | "shield-alert";
  isDangerous: boolean;
}
