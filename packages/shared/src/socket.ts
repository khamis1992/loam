export type TaskMode = 'standard' | 'lite' | 'max' | 'discuss' | 'cascade';
export type AgentStatus = 'running' | 'waiting' | 'stopped' | 'error';
export type ToolStatus = 'success' | 'error' | 'running' | 'pending' | 'failed' | 'cancelled' | 'stopped' | 'rollback' | 'argumentsFinished' | 'streaming';
export type ToolName = 'browser' | 'terminal' | 'search' | 'text_editor' | 'webdev' | 'map_reduce' | 'suggestion' | 'webpage_extract' | 'mcp' | (string & {});

/** Neo N10: the composer's output-type selector. */
export const OUTPUT_TYPES = ['auto', 'text', 'image', 'video', 'slides', 'website'] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];
/** Neo N10: the composer's effort selector. */
export type EffortLevel = 'fast' | 'max';

// The selector values are mirrored from the backend's `src/llm/router.ts` so a
// composer payload that was built by hand still type checks; the server
// re-validates every value before it reaches the routing map.

export interface Attachment {
  id: string;
  filename: string;
  type: 'file';
  url: string;
  contentType: string;
  fileMetaData?: { tag: 'upload'; uploadStatus: 'success' | 'uploading' | 'error'; uploadProgress: number };
}

export interface ServerAttachment extends Omit<Attachment, 'fileMetaData'> {
  contentLength: number;
  path?: string;
}

interface Base { id: string; timestamp: number; }

export interface JoinSession extends Base {
  type: 'join_session';
  sessionId: string;
  lastMessageId?: string;
  version: 2;
}

export interface LeaveSession extends Base {
  type: 'leave_session';
  sessionId: string;
}

export interface UserMessage extends Base {
  type: 'user_message';
  sessionId: string;
  messageStatus: 'pending';
  messageType: 'text';
  taskMode: TaskMode;
  content: '';
  contents: { type: 'text'; value: string }[];
  attachments: Attachment[];
  deliveryMode?: 'interrupt' | 'queue' | 'send';
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
    executionTarget?: { kind: 'sandbox' | 'desktop' };
    desktopBinding?: { deviceId: string; folderPath: string };
    /** Option 17: start the task in a fresh git worktree under the bound folder. */
    worktreeEnabled?: boolean;
    /** Option 18: composer model tier ("max" | "standard" | "lite" | "flex"). */
    modelTier?: string;
    /** Neo N3: opt this run into the user's Knowledge Garden (kb_* tools). */
    knowledge?: boolean;
    /** Neo N10: composer output type (auto|text|image|video|slides|website). */
    outputType?: string;
    /** Neo N10: composer effort level (fast|max). */
    effort?: string;
    /** Neo N10: explicit A/B arm model ids for the fan-out run. */
    abModels?: string[];
  };
}

export interface StopSession extends Base {
  type: 'stop_session';
  sessionId: string;
}

export type ClientMessage = JoinSession | LeaveSession | UserMessage | StopSession;

export interface ServerEnvelope<E extends ChatEvent = ChatEvent> {
  id: string;
  type: 'event';
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
  type: 'chat';
  sender: 'user' | 'assistant';
  senderId?: string;
  messageType: 'text';
  content: string;
  contents?: ({ type: 'text'; value: string } | { type: 'attachment'; attachment: ServerAttachment })[];
  attachments: ServerAttachment[];
  deliveryKind?: 'opening' | 'progress' | 'result' | 'provisional';
  taskMode?: TaskMode;
  qualityMode?: 'user' | 'standard' | (string & {});
}

export interface ChatDeltaEvent extends ChatEventBase {
  type: 'chatDelta';
  delta: { content: string };
  finished: boolean;
  sender: 'assistant';
  taskMode: TaskMode;
  qualityMode: string;
  deliveryKind: 'provisional' | 'result';
  rollback: boolean;
  targetEventId: string;
}

export interface StatusUpdateEvent extends ChatEventBase {
  type: 'statusUpdate';
  agentStatus: AgentStatus;
  brief: string;
  description?: string;
  planStepId?: string;
}

export interface QueueStatusChangeEvent extends ChatEventBase {
  type: 'queueStatusChange';
  queueStatus: 'done' | (string & {});
  taskMode: TaskMode;
}

export interface PlanUpdateEvent extends ChatEventBase {
  type: 'planUpdate';
  tasks: { status: 'doing' | 'done' | (string & {}); title: string; startedAt: number }[];
}

export interface NewPlanStepEvent extends ChatEventBase {
  type: 'newPlanStep';
  stepId: string;
  title: string;
}

/**
 * Neo N4 incremental Recipe engine: the live step list of a recipe-mode run.
 *
 * Sent whenever the recipe changes (after each step's result, after a restart).
 * Unlike `planUpdate`, which describes the plan as it was at the start, this
 * event carries the *current* recipe with per-step status and the remaining-work
 * estimate, so the right panel can show the recipe shrinking as the run proceeds.
 */
export interface RecipeUpdateEvent extends ChatEventBase {
  type: 'recipeUpdate';
  goal: string;
  steps: {
    id: string;
    title: string;
    instruction: string;
    successCriteria: string;
    status: 'proposed' | 'ready' | 'doing' | 'done' | 'blocked' | 'skipped';
    nodeId?: string;
    replaces?: string[];
    completedCount: number;
  }[];
  remainingEstimate: number;
  change: 'init' | 'propose' | 'advance' | 'rewrite' | 'drop' | 'restart';
  source: 'planner' | 'restart' | 'auto';
}

/** Neo N4: the recipe restarted from one step; downstream is regenerated. */
export interface RecipeRestartEvent extends ChatEventBase {
  type: 'recipeRestart';
  stepId: string;
  nodeId: string;
  keptSteps: string[];
  regeneratedSteps: string[];
  reason: string;
}

export interface TodoUpdateEvent extends ChatEventBase {
  type: 'todoUpdate';
  todos: { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | (string & {}) }[];
}

export interface LiveStatusEvent extends ChatEventBase {
  type: 'liveStatus';
  text: string;
}

export interface ModeEvent extends ChatEventBase {
  type: 'mode';
  mode: string;
  label: string;
  labelAr: string;
  reason?: string;
}

export interface AttachmentEvent extends ChatEventBase {
  type: 'attachment';
  name: string;
  path: string;
  mime: string;
  sizeBytes: number;
  taskId: string;
}

export interface ToolUsedEvent extends ChatEventBase {
  type: 'toolUsed';
  tool: ToolName;
  actionId: string;
  status: ToolStatus;
  planStepId?: string;
  brief?: string;
  description?: string;
  message?: { action: string; param?: Record<string, unknown> | string };
  detail?: { suggestion?: { commands: { content: string; commandType: 'followup_requirement' | (string & {}) }[] } };
  argumentsDetail?: Record<string, unknown>;
}

export interface UserStopEvent extends ChatEventBase {
  type: 'userStop';
}

export interface CascadeTaskClockEvent extends ChatEventBase {
  type: 'cascadeTaskClock';
  clock: {
    sessionId: string;
    taskId: string;
    startedAt: number;
    accumulatedMs: number;
    openSince?: number;
    phase: 'open' | 'closed' | (string & {});
    revision: number;
  };
}

export interface DesktopSessionConfigEvent extends ChatEventBase {
  type: 'desktopSessionConfig';
  mountedFolder: { deviceId: string; folderPath: string; folderName: string; status: 'mounted' | (string & {}) };
}

export interface DesktopDevicesUpdateEvent extends ChatEventBase {
  type: 'desktopDevicesUpdate';
  devices: {
    deviceId: string;
    deviceName: string;
    deviceType: 'desktop' | 'ps-standard' | (string & {});
    isConnected: boolean;
    folders: { path: string; name: string }[];
    configVersion: number;
    deviceInfo: { clientOS: 'windows' | 'macos' | 'linux' | (string & {}); clientVersion: string; mountLayout: 'device-scoped'; locale: string };
    supportsWorkspaceWrite: boolean;
    workspaceWriteSetup: 'ready' | 'unsupported' | (string & {});
  }[];
}

export interface LocalPermissionModeChangeResultEvent extends ChatEventBase {
  type: 'localPermissionModeChangeResult';
  fromEventId: string;
  sourceUserId: string;
  success: boolean;
  mode: 'approve_for_me' | (string & {});
}

export interface EventsNotifyEventsAfterEvent extends ChatEventBase {
  type: 'eventsNotifyEventsAfter';
  events: unknown[];
  eventId: string;
}

export interface ExplanationEvent extends ChatEventBase {
  type: 'explanation';
  content: string;
}

/** Prompt-cache (KV cache) accounting for one completed provider request. */
export interface CacheUsageEvent extends ChatEventBase {
  type: 'cache_usage';
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
  type: 'folderAccessRequest';
  requestId: string;
  path: string;
  access: 'read' | 'write';
}

/** Live browser frame from the agent's browser tool (throttled ~1 fps). */
export interface BrowserFrameEvent extends ChatEventBase {
  type: 'browserFrame';
  taskId: string;
  url: string;
  title?: string;
  /** JPEG bytes without the data: prefix; omitted for URL/title-only updates. */
  jpegBase64?: string;
}

/** Option 14: pending tool approval card (mirrors the protocol adapter's wire shape). */
export interface LocalExecutionApprovalRequestedEvent extends ChatEventBase {
  type: 'localExecutionApprovalRequested';
  requestId: string;
  reviewer: 'user' | 'auto';
  actionRef?: string;
  actionType?: 'terminal' | 'file' | 'workspace';
  summary?: string;
  purpose?: string;
  detail?:
    | { kind: 'file'; operation: string; path: string }
    | { kind: 'terminal'; command: string; cwd?: string; justification?: string; declaredNetwork?: boolean; writablePaths?: string[]; requireEscalated?: boolean; flaggedReason?: string }
    | { kind: 'workspace'; intent?: 'directory_access'; deviceId: string; path: string; previousPath?: string; requestedPath: string; createIfMissing?: boolean };
}

/** Option 14: user decision for a pending tool approval card. */
export interface LocalExecutionApprovalResolvedEvent extends ChatEventBase {
  type: 'localExecutionApprovalResolved';
  requestId: string;
  reviewer: 'user' | 'auto';
  result: 'approve' | 'deny';
}

/** D17: environment-issue report surfaced as an informational card. */
export interface EnvironmentIssueEvent extends ChatEventBase {
  type: 'environmentIssue';
  message: string;
  details?: string;
}

/** D4: a `suggest_plan` plan awaiting the user's decision (plan-approval card). */
export interface PlanApprovalRequestedEvent extends ChatEventBase {
  type: 'planApprovalRequested';
  requestId: string;
  taskId: string;
  summary: string;
  steps: string[];
  filesToEdit: string[];
  trivial: boolean;
}

/** D4: the user decided a pending plan-approval card. */
export interface PlanApprovalResolvedEvent extends ChatEventBase {
  type: 'planApprovalResolved';
  requestId: string;
  taskId: string;
  reviewer: 'user' | 'auto';
  result: 'approve' | 'reject' | 'edit';
  plan?: { summary?: string; steps?: string[]; files_to_edit?: string[]; trivial?: boolean };
}

/** N9: an `ask_user` clarification request awaiting the user's answer (ask-user card). */
export interface AskUserRequestedEvent extends ChatEventBase {
  type: 'askUserRequested';
  requestId: string;
  taskId: string;
  title: string;
  reason: string;
  questions: Array<{ id: string; prompt: string; options?: string[]; allowFile?: boolean }>;
  /** "auto" is the orchestrator's vague/missing-context trigger; "model" a tool call. */
  source?: 'auto' | 'model';
  /** Set when `source` is "auto"; the client localizes the reason from it. */
  reasonCode?: 'vague' | 'missing_context' | 'ambiguous_target';
}

/** N9: the user answered or dismissed a pending ask-user card. */
export interface AskUserResolvedEvent extends ChatEventBase {
  type: 'askUserResolved';
  requestId: string;
  taskId: string;
  reviewer: 'user' | 'auto';
  result: 'answered' | 'dismissed' | 'expired';
  answer?: {
    text: string;
    answers: Record<string, string>;
    files: Array<{ path: string; name: string; bytes: number; contentType: string }>;
  };
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
  | FolderAccessRequestEvent
  | BrowserFrameEvent
  | LocalExecutionApprovalRequestedEvent
  | LocalExecutionApprovalResolvedEvent
  | EnvironmentIssueEvent
  | PlanApprovalRequestedEvent
  | PlanApprovalResolvedEvent
  | AskUserRequestedEvent
  | AskUserResolvedEvent
  | RecipeUpdateEvent
  | RecipeRestartEvent;

export type ServerMessage = ServerEnvelope | { type: 'session_write_access'; sessionId: string; writable: boolean };
