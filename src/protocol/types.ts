/** Manus-style socket message types (§7.2). Mirror of packages/shared/src/socket.ts
 *  until A2 lands the canonical shared package. */
import type { LocalPermissionMode } from "../policy/permissionModes.js";

export type TaskMode = "standard" | "lite" | "max" | "discuss" | "cascade";
export type AgentStatus = "running" | "waiting" | "stopped" | "error";
export type ToolStatus = "success" | "error" | "running" | "pending" | "failed" | "cancelled" | "stopped" | "rollback" | "argumentsFinished" | "streaming";
export type ToolName = "browser" | "terminal" | "search" | "text_editor" | "webdev" | "map_reduce" | "suggestion" | "mcp" | "webpage_extract" | (string & {});

export interface Attachment {
  id: string;
  filename: string;
  type: "file";
  url: string;
  contentType: string;
  fileMetaData?: { tag: "upload"; uploadStatus: "success" | "uploading" | "error"; uploadProgress: number };
}

export interface ServerAttachment extends Omit<Attachment, "fileMetaData"> {
  contentLength: number;
  path?: string;
}

interface Base {
  id: string;
  timestamp: number;
}

export interface JoinSession extends Base {
  type: "join_session";
  sessionId: string;
  lastMessageId?: string;
  version: 2;
}

export interface LeaveSession extends Base {
  type: "leave_session";
  sessionId: string;
}

export interface UserMessage extends Base {
  type: "user_message";
  sessionId: string;
  messageStatus: "pending";
  messageType: "text";
  taskMode: TaskMode;
  content: "";
  contents: { type: "text"; value: string }[];
  attachments: Attachment[];
  deliveryMode?: "interrupt" | "queue" | "send";
  extData: {
    capabilities: {
      enabledAddons: string[];
      connectorAccounts: { connectorUid: string; allowedAccounts: { accountUid: string; accountName: string }[] }[];
      enabledConnectors: { name: string; iconUrl: string; uid: string; type: 1 | 2 | 3; builtConfig?: unknown }[];
      enabledSkills?: string[];
    };
    mode?: TaskMode;
    loamMode?: string;
    projectId?: string;
    agentId?: string;
    workMode?: string;
    executionTarget?: { kind: "sandbox" | "desktop" };
    desktopBinding?: { deviceId: string; folderPath: string };
    localPermissionMode?: LocalPermissionMode;
    /** MF4: per-task "Approve for me" toggle carried with each message. */
    approveForMe?: boolean;
    worktreeEnabled?: boolean;
    /** Option 18: composer model tier ("max" | "standard" | "lite" | "flex"). */
    modelTier?: string;
  };
}

export interface StopSession extends Base {
  type: "stop_session";
  sessionId: string;
}

export interface SubmitWorkspaceDirectoryAccess extends Base {
  type: "submit_workspace_directory_access";
  sessionId: string;
  requestActionId: string;
  accept: boolean;
  directory?: { deviceId: string; name: string; path: string };
}

export interface ResolveLocalExecutionApproval extends Base {
  type: "resolve_local_execution_approval";
  sessionId: string;
  requestId: string;
  /** "always" approves once AND persists an allow rule scoped to the task's agent. */
  resolution: "approve" | "deny" | "always" | string;
  targetActionEventId?: string;
}

export type ClientMessage = JoinSession | LeaveSession | UserMessage | StopSession | SubmitWorkspaceDirectoryAccess | ResolveLocalExecutionApproval;

export interface ServerEnvelope<E extends ChatEvent = ChatEvent> {
  id: string;
  type: "event";
  sessionId: string;
  timestamp: number;
  event: E;
  webdevAddonEnabled?: boolean;
}

export interface ChatEventBase extends Base {
  noPersistent?: boolean;
  noRender?: boolean;
}

export interface ChatMessageEvent extends ChatEventBase {
  type: "chat";
  sender: "user" | "assistant";
  senderId?: string;
  messageType: "text";
  content: string;
  contents?: ({ type: "text"; value: string } | { type: "attachment"; attachment: ServerAttachment })[];
  attachments: ServerAttachment[];
  deliveryKind?: "opening" | "progress" | "result" | "provisional";
  taskMode?: TaskMode;
  qualityMode?: "user" | "standard" | (string & {});
}

export interface ChatDeltaEvent extends ChatEventBase {
  type: "chatDelta";
  delta: { content: string };
  finished: boolean;
  sender: "assistant";
  taskMode: TaskMode;
  qualityMode: string;
  deliveryKind: "provisional" | "result";
  rollback: boolean;
  targetEventId: string;
}

export interface StatusUpdateEvent extends ChatEventBase {
  type: "statusUpdate";
  agentStatus: AgentStatus;
  brief: string;
  description?: string;
  planStepId?: string;
}

export interface QueueStatusChangeEvent extends ChatEventBase {
  type: "queueStatusChange";
  queueStatus: "done" | (string & {});
  taskMode: TaskMode;
}

export interface PlanUpdateEvent extends ChatEventBase {
  type: "planUpdate";
  tasks: { status: "doing" | "done" | (string & {}); title: string; startedAt?: number; endAt?: number }[];
}

export interface NewPlanStepEvent extends ChatEventBase {
  type: "newPlanStep";
  stepId: string;
  title: string;
}

export interface LiveStatusEvent extends ChatEventBase {
  type: "liveStatus";
  text: string;
}

export interface ModeEvent extends ChatEventBase {
  type: "mode";
  mode: string;
  label: string;
  labelAr: string;
  reason?: string;
}

export interface AttachmentEvent extends ChatEventBase {
  type: "attachment";
  name: string;
  path: string;
  mime: string;
  sizeBytes: number;
  taskId: string;
}

export type ToolDetail =
  | { terminal: { shellId: string; action: "execute"; command: string; output?: string[]; outputType?: "append"; finished?: boolean } }
  | { textEditor: { action: "read" | "write" | "update"; path: string; content?: string; oldContent?: string } }
  | { search: { queries: string[]; results: { title: string; link: string; snippet: string; favicon?: string }[] } }
  | { webpageExtract: { action: "extract"; url: string; markdown: string; truncated: boolean } }
  | { mcp: { server: string; tool: string; primitive: "tool"; action: "get" | "call"; connectorName: string; argumentsPreview?: string; resultPreview?: string } }
  | { suggestion: { commands: { content: string; commandType: "followup_requirement" }[] } };

export interface ToolUsedEvent extends ChatEventBase {
  type: "toolUsed";
  tool: ToolName;
  actionId: string;
  status: ToolStatus;
  planStepId?: string;
  brief?: string;
  description?: string;
  message?: { action: string; param?: string };
  argumentsDetail?: ToolDetail;
  detail?: ToolDetail;
  isConnector?: boolean;
}

export interface UserStopEvent extends ChatEventBase {
  type: "userStop";
}

export interface CascadeTaskClockEvent extends ChatEventBase {
  type: "cascadeTaskClock";
  clock: {
    sessionId: string;
    taskId: string;
    startedAt: number;
    accumulatedMs: number;
    openSince?: number;
    phase: "open" | "closed" | (string & {});
    revision: number;
  };
}

export interface DesktopSessionConfigEvent extends ChatEventBase {
  type: "desktopSessionConfig";
  mountedFolder: { deviceId: string; folderPath: string; folderName: string; status: "mounted" | (string & {}) };
}

export interface DesktopDevicesUpdateEvent extends ChatEventBase {
  type: "desktopDevicesUpdate";
  devices: {
    deviceId: string;
    deviceName: string;
    deviceType: "desktop" | "ps-standard" | (string & {});
    isConnected: boolean;
    folders: { path: string; name: string }[];
    configVersion: number;
    deviceInfo: { clientOS: "windows" | "macos" | "linux" | (string & {}); clientVersion: string; mountLayout: "device-scoped"; locale: string };
    supportsWorkspaceWrite: boolean;
    workspaceWriteSetup: "ready" | "unsupported" | (string & {});
  }[];
}

export interface LocalPermissionModeChangeResultEvent extends ChatEventBase {
  type: "localPermissionModeChangeResult";
  fromEventId: string;
  sourceUserId: string;
  success: boolean;
  mode: "approve_for_me" | (string & {});
  previousMode?: string;
}

export interface EventsNotifyEventsAfterEvent extends ChatEventBase {
  type: "eventsNotifyEventsAfter";
  events: ChatEvent[];
  eventId: string;
}

export interface ExplanationEvent extends ChatEventBase {
  type: "explanation";
  content: string;
}

export interface FolderAccessRequestEvent extends ChatEventBase {
  type: "folderAccessRequest";
  requestId: string;
  path: string;
  access: "read" | "write";
}

export interface WorkspaceDirectoryAccessRequest extends ChatEventBase {
  type: "workspaceDirectoryAccessRequest";
  actionId: string;
  deviceId?: string;
  deviceName?: string;
  environmentId?: string;
  purpose?: "access" | "switch" | string;
  intent?: "switch_device" | string;
  requestedPath?: string;
  stepId?: string;
}

export interface WorkspaceDirectoryAccessResult extends ChatEventBase {
  type: "workspaceDirectoryAccessResult";
  requestActionId: string;
  success: boolean;
  cancelled?: boolean;
  error?: string;
}

export interface LocalExecutionApprovalRequested extends ChatEventBase {
  type: "localExecutionApprovalRequested";
  requestId: string;
  reviewer: "user" | "auto";
  actionRef?: string;
  actionType?: "terminal" | "file" | "workspace";
  summary?: string;
  purpose?: string;
  detail?:
    | { kind: "file"; operation: string; path: string }
    | { kind: "terminal"; command: string; cwd?: string; justification?: string; declaredNetwork?: boolean; writablePaths?: string[]; requireEscalated?: boolean; flaggedReason?: string }
    | { kind: "workspace"; intent?: "directory_access"; deviceId: string; path: string; previousPath?: string; requestedPath: string; createIfMissing?: boolean };
}

export interface LocalExecutionApprovalResolved extends ChatEventBase {
  type: "localExecutionApprovalResolved";
  requestId: string;
  reviewer: "user" | "auto";
  result: "approve" | "deny";
}

export interface DeviceAttachmentUploadNotify extends ChatEventBase {
  type: "deviceAttachmentUploadNotify";
  targetEventId: string;
  path: string;
  status: "done" | "failed";
  url: string;
  contentType: string;
  contentLength: number;
}

export type ChatEvent =
  | ChatMessageEvent
  | ChatDeltaEvent
  | StatusUpdateEvent
  | QueueStatusChangeEvent
  | PlanUpdateEvent
  | NewPlanStepEvent
  | LiveStatusEvent
  | ModeEvent
  | AttachmentEvent
  | ToolUsedEvent
  | UserStopEvent
  | CascadeTaskClockEvent
  | DesktopSessionConfigEvent
  | DesktopDevicesUpdateEvent
  | LocalPermissionModeChangeResultEvent
  | EventsNotifyEventsAfterEvent
  | ExplanationEvent
  | FolderAccessRequestEvent
  | WorkspaceDirectoryAccessRequest
  | WorkspaceDirectoryAccessResult
  | LocalExecutionApprovalRequested
  | LocalExecutionApprovalResolved
  | DeviceAttachmentUploadNotify;

export type ServerMessage = ServerEnvelope | { type: "session_write_access"; sessionId: string; writable: boolean };
