/** Local event shapes consumed by the approval components.
 *  These are intentionally independent of @shared/socket so the component files
 *  can be authored before A2's shared types land.
 */
export interface FolderAccessRequestEvent {
  type: "folderAccessRequest";
  id: string;
  timestamp: number;
  requestId: string;
  path: string;
  access: "read" | "write";
}

export type ExecutionDetail =
  | { kind: "file"; operation: string; path: string }
  | {
      kind: "terminal";
      command: string;
      cwd?: string;
      justification?: string;
      declaredNetwork?: boolean;
      writablePaths?: string[];
      requireEscalated?: boolean;
      flaggedReason?: string;
    }
  | {
      kind: "workspace";
      intent?: "directory_access";
      deviceId: string;
      path: string;
      previousPath?: string;
      requestedPath: string;
      createIfMissing?: boolean;
    };

export interface LocalExecutionApprovalRequested {
  type: "localExecutionApprovalRequested";
  id: string;
  timestamp: number;
  requestId: string;
  reviewer: "user" | "auto";
  actionRef?: string;
  actionType?: "terminal" | "file" | "workspace";
  summary?: string;
  purpose?: string;
  detail: ExecutionDetail;
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
