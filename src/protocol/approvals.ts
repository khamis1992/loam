/**
 * Manus-style approval protocol events and bridge to Loam's `src/server/approvals.ts`.
 *
 * The protocol adapter (A1) should import this module and:
 *  - wrap Loam `approval_required` events as `localExecutionApprovalRequested`
 *  - route `resolve_local_execution_approval` frames to `resolveLocalExecutionApproval`
 *  - route `submit_workspace_directory_access` frames to `submitWorkspaceDirectoryAccess`
 *  - route `change_local_permission_mode` frames to `changeLocalPermissionMode`
 */
import crypto from "node:crypto";
import {
  createApproval,
  decideApproval,
  getApproval,
  type ApprovalRecord,
} from "../server/approvals.js";
import {
  type LocalPermissionMode,
  type FolderGrant,
  type LocalActionKind,
  reviewLocalAction,
} from "../policy/permissionModes.js";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function shortUid(): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.randomBytes(22);
  return Array.from(bytes, (b) => alphabet[b % 62]).join("");
}

function now(): number {
  return Date.now();
}

// ----------------------------------------------------------------------------
// Event types (matches BUILD_SPEC §7.2.2)
// ----------------------------------------------------------------------------

export interface WorkspaceDirectoryAccessRequest {
  type: "workspaceDirectoryAccessRequest";
  id: string;
  timestamp: number;
  actionId: string;
  deviceId?: string;
  deviceName?: string;
  environmentId?: string;
  purpose?: "access" | "switch" | string;
  intent?: "switch_device" | string;
  requestedPath?: string;
  stepId?: string;
}

export interface WorkspaceDirectoryAccessResult {
  type: "workspaceDirectoryAccessResult";
  id: string;
  timestamp: number;
  requestActionId: string;
  success: boolean;
  cancelled?: boolean;
  error?: string;
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

export interface LocalExecutionApprovalResolved {
  type: "localExecutionApprovalResolved";
  id: string;
  timestamp: number;
  requestId: string;
  reviewer: "user" | "auto";
  result: "approve" | "deny";
}

export interface SubmitWorkspaceDirectoryAccess {
  type: "submit_workspace_directory_access";
  sessionId: string;
  requestActionId: string;
  accept: boolean;
  directory?: { deviceId: string; name: string; path: string };
}

export interface ResolveLocalExecutionApproval {
  type: "resolve_local_execution_approval";
  sessionId: string;
  requestId: string;
  resolution: "approve" | "deny" | string;
  targetActionEventId?: string;
}

export interface ChangeLocalPermissionMode {
  type: "change_local_permission_mode";
  sessionId: string;
  mode: LocalPermissionMode;
}

export interface LocalPermissionModeChangeResult {
  type: "localPermissionModeChangeResult";
  id: string;
  timestamp: number;
  mode: LocalPermissionMode;
  previousMode: LocalPermissionMode;
  success: boolean;
  sourceUserId: string;
  fromEventId: string;
}

export interface FolderAccessRequestEvent {
  type: "folderAccessRequest";
  id: string;
  timestamp: number;
  requestId: string;
  path: string;
  access: "read" | "write";
}

// ----------------------------------------------------------------------------
// Workspace directory access (separate from Loam host-input approvals)
// ----------------------------------------------------------------------------

interface PendingDirectoryRequest {
  request: WorkspaceDirectoryAccessRequest;
  resolve: (value: WorkspaceDirectoryAccessResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const pendingDirectoryRequests = new Map<string, PendingDirectoryRequest>();
const DIRECTORY_TIMEOUT_MS = 15 * 60_000;

export function createWorkspaceDirectoryAccessRequest(
  input: Omit<WorkspaceDirectoryAccessRequest, "type" | "id" | "timestamp">,
): WorkspaceDirectoryAccessRequest {
  return { type: "workspaceDirectoryAccessRequest", id: shortUid(), timestamp: now(), ...input };
}

export function submitWorkspaceDirectoryAccess(
  input: SubmitWorkspaceDirectoryAccess,
): WorkspaceDirectoryAccessResult {
  const pending = pendingDirectoryRequests.get(input.requestActionId);
  if (pending) {
    clearTimeout(pending.timeout);
  }
  if (!pending) {
    return {
      type: "workspaceDirectoryAccessResult",
      id: shortUid(),
      timestamp: now(),
      requestActionId: input.requestActionId,
      success: false,
      error: "Request already resolved or expired.",
    };
  }

  if (!input.accept) {
    const result: WorkspaceDirectoryAccessResult = {
      type: "workspaceDirectoryAccessResult",
      id: shortUid(),
      timestamp: now(),
      requestActionId: input.requestActionId,
      success: false,
      cancelled: true,
    };
    pending.resolve(result);
    pendingDirectoryRequests.delete(input.requestActionId);
    return result;
  }

  const result: WorkspaceDirectoryAccessResult = {
    type: "workspaceDirectoryAccessResult",
    id: shortUid(),
    timestamp: now(),
    requestActionId: input.requestActionId,
    success: true,
  };
  pending.resolve(result);
  pendingDirectoryRequests.delete(input.requestActionId);
  return result;
}

export function waitForWorkspaceDirectoryAccess(
  request: WorkspaceDirectoryAccessRequest,
  signal?: AbortSignal,
): Promise<WorkspaceDirectoryAccessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({
        type: "workspaceDirectoryAccessResult",
        id: shortUid(),
        timestamp: now(),
        requestActionId: request.actionId,
        success: false,
        cancelled: true,
      });
      return;
    }

    let settled = false;
    const entry: PendingDirectoryRequest = {
      request,
      resolve: (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      },
      timeout: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    pendingDirectoryRequests.set(request.actionId, entry);

    const timeout = setTimeout(() => {
      if (!pendingDirectoryRequests.has(request.actionId)) return;
      const expired: WorkspaceDirectoryAccessResult = {
        type: "workspaceDirectoryAccessResult",
        id: shortUid(),
        timestamp: now(),
        requestActionId: request.actionId,
        success: false,
        cancelled: false,
        error: "Request expired",
      };
      pendingDirectoryRequests.delete(request.actionId);
      entry.resolve(expired);
    }, DIRECTORY_TIMEOUT_MS);
    entry.timeout = timeout;

    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      pendingDirectoryRequests.delete(request.actionId);
      entry.resolve({
        type: "workspaceDirectoryAccessResult",
        id: shortUid(),
        timestamp: now(),
        requestActionId: request.actionId,
        success: false,
        cancelled: true,
      });
    });
  });
}

// ----------------------------------------------------------------------------
// Local execution approval bridge
// ----------------------------------------------------------------------------

export interface LocalApprovalPolicyInput {
  permissionMode: LocalPermissionMode;
  actionType: "terminal" | "file" | "workspace";
  detail: ExecutionDetail;
  grants?: ReadonlyArray<FolderGrant>;
}

/**
 * Inspect the action and the active permission mode, then either:
 *  - return `reviewer:'auto'` with no request id (auto-approve safe actions), or
 *  - create a Loam approval record and return a `localExecutionApprovalRequested` event.
 */
export function requestLocalExecutionApproval(
  input: LocalApprovalPolicyInput,
): { event?: LocalExecutionApprovalRequested; autoResult?: "approve" | "deny" } {
  const kind = input.detail.kind;
  const actionKind: LocalActionKind =
    input.actionType === "file"
      ? kind === "file" && input.detail.operation === "read"
        ? "read"
        : "write"
      : input.actionType === "terminal"
        ? "terminal"
        : "workspace";

  const targetPath =
    kind === "file"
      ? input.detail.path
      : kind === "terminal"
        ? input.detail.cwd
        : kind === "workspace"
          ? input.detail.requestedPath
          : undefined;

  const review = reviewLocalAction({
    mode: input.permissionMode,
    action: actionKind,
    targetPath,
    requiresNetwork: kind === "terminal" ? input.detail.declaredNetwork : undefined,
    flaggedReason: kind === "terminal" ? input.detail.flaggedReason : undefined,
    grants: input.grants,
  });

  if (!review.needsApproval) {
    return { autoResult: "approve" };
  }

  const approval = createApproval({
    taskId: input.detail.kind === "workspace" ? input.detail.deviceId : "local-task",
    tool: input.actionType,
    summary: input.detail.kind === "terminal"
      ? `Run a local command: ${input.detail.command.slice(0, 80)}`
      : input.detail.kind === "file"
        ? `Modify a local file: ${input.detail.path}`
        : "Folder access request",
    argsPreview: JSON.stringify(input.detail),
  });

  const event: LocalExecutionApprovalRequested = {
    type: "localExecutionApprovalRequested",
    id: shortUid(),
    timestamp: now(),
    requestId: approval.id,
    reviewer: "user",
    actionRef: approval.id,
    actionType: input.actionType,
    summary: approval.summary,
    detail: input.detail,
  };

  return { event };
}

/** Resolve a local execution approval. Returns the resolved event and the Loam record. */
export function resolveLocalExecutionApproval(
  input: ResolveLocalExecutionApproval,
): { event: LocalExecutionApprovalResolved; record?: ApprovalRecord } {
  const resolution = input.resolution === "approve" ? "approve" : "deny";
  const record = decideApproval(input.requestId, resolution);
  const event: LocalExecutionApprovalResolved = {
    type: "localExecutionApprovalResolved",
    id: shortUid(),
    timestamp: now(),
    requestId: input.requestId,
    reviewer: "user",
    result: resolution === "approve" ? "approve" : "deny",
  };
  return { event, record };
}

/** Optimistic client-side resolution before the server confirms (BUILD_SPEC §7.2.2). */
export function createOptimisticLocalExecutionResolution(
  requestId: string,
  result: "approve" | "deny",
): LocalExecutionApprovalResolved {
  return {
    type: "localExecutionApprovalResolved",
    id: shortUid(),
    timestamp: now(),
    requestId,
    reviewer: "user",
    result,
  };
}

/** Expose the underlying approval record for diagnostics / UI rendering. */
export function getLocalExecutionApprovalRecord(requestId: string): ApprovalRecord | undefined {
  return getApproval(requestId);
}

// ----------------------------------------------------------------------------
// Folder access request (chat card)
// ----------------------------------------------------------------------------

export function createFolderAccessRequestEvent(
  requestId: string,
  path: string,
  access: "read" | "write" = "write",
): FolderAccessRequestEvent {
  return { type: "folderAccessRequest", id: shortUid(), timestamp: now(), requestId, path, access };
}

// ----------------------------------------------------------------------------
// Permission mode changes
// ----------------------------------------------------------------------------

export function changeLocalPermissionMode(
  input: ChangeLocalPermissionMode,
  previousMode: LocalPermissionMode,
  sourceUserId: string,
  fromEventId: string,
): LocalPermissionModeChangeResult {
  return {
    type: "localPermissionModeChangeResult",
    id: shortUid(),
    timestamp: now(),
    mode: input.mode,
    previousMode,
    success: true,
    sourceUserId,
    fromEventId,
  };
}

// ----------------------------------------------------------------------------
// Deny guard: ensure a denied request cannot produce a side effect.
// ----------------------------------------------------------------------------

export function isDeniedOrExpired(requestId: string): boolean {
  const rec = getApproval(requestId);
  return rec !== undefined && (rec.status === "denied" || rec.status === "expired");
}
