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
  /** BUILD_SPEC §6.4: the highest durable log sequence this client has already
   *  rendered. When present the server replays by sequence (events with
   *  `seq > lastSeq`), which survives a client that never saw a given event id.
   *  Omitted by older clients, which fall back to `lastMessageId`. */
  lastSeq?: number;
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
    /** Neo N3: opt this run into the user's Knowledge Garden (kb_* tools). */
    knowledge?: boolean;
    /** Legal mode: id of the active matter (opaque; the server reloads it from the encrypted store). */
    legalMatterId?: string;
    /** Neo N10: composer output type (Auto/Text/Image/Video/Slides/Website). */
    outputType?: string;
    /** Neo N10: composer effort level (Fast/Max). */
    effort?: string;
    /** Neo N10: explicit A/B arm model ids, when the composer asked for a fan-out. */
    abModels?: string[];
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

/** D4: user decision for a pending `suggest_plan` plan-approval card. */
export interface ResolvePlanApproval extends Base {
  type: "resolve_plan_approval";
  sessionId: string;
  requestId: string;
  decision: "approve" | "reject" | "edit";
  /** Revised plan when `decision` is "edit". */
  plan?: { summary?: string; steps?: string[]; files_to_edit?: string[]; trivial?: boolean };
}

/** N9: user answer for a pending `ask_user` clarification card. */
export interface ResolveAskUser extends Base {
  type: "resolve_ask_user";
  sessionId: string;
  requestId: string;
  /** "dismiss" closes the card without answering; anything else is an answer. */
  decision: "answer" | "dismiss" | string;
  answer?: {
    text?: string;
    answers?: Record<string, string>;
    files?: Array<{ path: string; name: string; bytes: number; contentType: string }>;
  };
}

export type ClientMessage =
  | JoinSession
  | LeaveSession
  | UserMessage
  | StopSession
  | SubmitWorkspaceDirectoryAccess
  | ResolveLocalExecutionApproval
  | ResolvePlanApproval
  | ResolveAskUser;

export interface ServerEnvelope<E extends ChatEvent = ChatEvent> {
  id: string;
  type: "event";
  sessionId: string;
  timestamp: number;
  event: E;
  webdevAddonEnabled?: boolean;
  /** BUILD_SPEC §6.4: the durable log sequence of this frame (optional so older
   *  clients are unaffected). */
  seq?: number;
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

/**
 * Neo N4 incremental Recipe engine: the live step list of a recipe-mode run.
 *
 * Unlike `PlanUpdateEvent` (the plan as it was at the start), this carries the
 * *current* recipe with per-step status and the remaining-work estimate, so the
 * client can render a recipe that changes as each step produces a result.
 */
export interface RecipeUpdateEvent extends ChatEventBase {
  type: "recipeUpdate";
  goal: string;
  steps: {
    id: string;
    title: string;
    instruction: string;
    successCriteria: string;
    status: "proposed" | "ready" | "doing" | "done" | "blocked" | "skipped";
    nodeId?: string;
    replaces?: string[];
    completedCount: number;
  }[];
  remainingEstimate: number;
  change: "init" | "propose" | "advance" | "rewrite" | "drop" | "restart";
  source: "planner" | "restart" | "auto";
}

/** Neo N4: the recipe restarted from one step; downstream is regenerated. */
export interface RecipeRestartEvent extends ChatEventBase {
  type: "recipeRestart";
  stepId: string;
  nodeId: string;
  keptSteps: string[];
  regeneratedSteps: string[];
  reason: string;
}

export interface TodoUpdateEvent extends ChatEventBase {
  type: "todoUpdate";
  todos: { id: string; content: string; status: "pending" | "in_progress" | "completed" | (string & {}) }[];
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

/** Verbatim context pruning ran before any summary; pruned bodies stay recallable. */
export interface ContextPrunedEvent extends ChatEventBase {
  type: "context_pruned";
  strategy: "prune" | "prune_then_summary";
  scorer: string;
  fallback: boolean;
  kept: number;
  truncated: number;
  dropped: number;
  pinned: number;
  charsBefore: number;
  charsAfter: number;
  tokensBefore: number;
  tokensAfter: number;
}

/** Prompt-cache (KV cache) accounting for one completed provider request. */
export interface CacheUsageEvent extends ChatEventBase {
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

/** D17: environment-issue report surfaced as an informational card. */
export interface EnvironmentIssueEvent extends ChatEventBase {
  type: "environmentIssue";
  message: string;
  details?: string;
}

/**
 * MiroFish swarm simulation progress (M3). The M3 loop emits round/agent
 * milestones; the payload shape is owned by `tools/mirofish/types.ts` and is
 * mirrored here structurally so the protocol layer stays free of tool imports.
 */
export interface SimulationProgressEvent extends ChatEventBase {
  type: "simulation_progress";
  sessionId: string;
  payload: {
    type:
      | "simulation_start"
      | "simulation_round_start"
      | "simulation_agent"
      | "simulation_round"
      | "simulation_arm_done"
      | "simulation_done";
    sessionId: string;
    agents?: number;
    rounds?: number;
    arms?: string[];
    arm?: "baseline" | "scenario";
    round?: number;
    totalRounds?: number;
    agentId?: string;
    agentName?: string;
    ok?: boolean;
    action?: "post" | "comment" | "share" | "ignore" | "buy" | "cancel";
    error?: string;
    metrics?: unknown;
    calls?: number;
    failures?: number;
    modelCalls?: number;
    comparison?: unknown;
    [key: string]: unknown;
  };
}

/** D4: a `suggest_plan` plan awaiting the user's decision (plan-approval card). */
export interface PlanApprovalRequestedEvent extends ChatEventBase {
  type: "planApprovalRequested";
  requestId: string;
  taskId: string;
  summary: string;
  steps: string[];
  filesToEdit: string[];
  trivial: boolean;
}

/** D4: the user decided a pending plan-approval card. */
export interface PlanApprovalResolvedEvent extends ChatEventBase {
  type: "planApprovalResolved";
  requestId: string;
  taskId: string;
  reviewer: "user" | "auto";
  result: "approve" | "reject" | "edit";
  plan?: { summary?: string; steps?: string[]; files_to_edit?: string[]; trivial?: boolean };
}

/** N9: a `ask_user` clarification request awaiting the user's answer. */
export interface AskUserRequestedEvent extends ChatEventBase {
  type: "askUserRequested";
  requestId: string;
  taskId: string;
  title: string;
  reason: string;
  questions: Array<{ id: string; prompt: string; options?: string[]; allowFile?: boolean }>;
  /** "auto" is the orchestrator's vague/missing-context trigger; "model" a tool call. */
  source?: "auto" | "model";
  /** Set when `source` is "auto"; the client localizes the reason from it. */
  reasonCode?: "vague" | "missing_context" | "ambiguous_target";
}

/** N9: the user answered or dismissed a pending ask-user card. */
export interface AskUserResolvedEvent extends ChatEventBase {
  type: "askUserResolved";
  requestId: string;
  taskId: string;
  reviewer: "user" | "auto";
  result: "answered" | "dismissed" | "expired";
  answer?: {
    text: string;
    answers: Record<string, string>;
    files: Array<{ path: string; name: string; bytes: number; contentType: string }>;
  };
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
  | TodoUpdateEvent
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
  | CacheUsageEvent
  | ContextPrunedEvent
  | FolderAccessRequestEvent
  | WorkspaceDirectoryAccessRequest
  | WorkspaceDirectoryAccessResult
  | LocalExecutionApprovalRequested
  | PlanApprovalRequestedEvent
  | PlanApprovalResolvedEvent
  | LocalExecutionApprovalResolved
  | EnvironmentIssueEvent
  | SimulationProgressEvent
  | AskUserRequestedEvent
  | AskUserResolvedEvent
  | DeviceAttachmentUploadNotify
  | RecipeUpdateEvent
  | RecipeRestartEvent;

export type ServerMessage = ServerEnvelope | { type: "session_write_access"; sessionId: string; writable: boolean };
