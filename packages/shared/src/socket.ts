/**
 * Socket message types per BUILD_SPEC §7.2.
 * Field names and envelope shapes mirror the observed Manus Studio 2.0 wire protocol.
 */

export type TaskMode = 'standard' | 'lite' | 'max' | 'discuss' | 'cascade';

export type AgentStatus = 'running' | 'waiting' | 'stopped' | 'error';

export type ToolStatus =
  | 'success'
  | 'error'
  | 'running'
  | 'pending'
  | 'failed'
  | 'cancelled'
  | 'stopped'
  | 'rollback'
  | 'argumentsFinished'
  | 'streaming';

export type ToolName =
  | 'browser'
  | 'terminal'
  | 'search'
  | 'text_editor'
  | 'webdev'
  | 'map_reduce'
  | 'suggestion'
  | 'webpage_extract'
  | 'mcp'
  | (string & {});

/** Attachment as sent in user_message [O-RT] */
export interface Attachment {
  id: string;
  filename: string;
  type: 'file';
  url: string;
  contentType: string;
  fileMetaData?: {
    tag: 'upload';
    uploadStatus: 'success' | 'uploading' | 'error';
    uploadProgress: number;
  };
}

/** Attachment as echoed by the server inside event.chat [O-RT] */
export interface ServerAttachment extends Omit<Attachment, 'fileMetaData'> {
  contentLength: number;
  path?: string;
}

interface Base {
  id: string;
  timestamp: number;
}

// ---------- client → server (socket.io event "message") ----------

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
      connectorAccounts: {
        connectorUid: string;
        allowedAccounts: { accountUid: string; accountName: string }[];
      }[];
      enabledConnectors: {
        name: string;
        iconUrl: string;
        uid: string;
        type: 1 | 2 | 3;
        builtConfig?: unknown;
      }[];
      enabledSkills?: string[];
    };
    mode?: TaskMode;
    projectId?: string;
    executionTarget?: { kind: 'sandbox' | 'desktop' };
    desktopBinding?: { deviceId: string; folderPath: string };
  };
}

export interface StopSession extends Base {
  type: 'stop_session';
  sessionId: string;
}

export interface SubmitWorkspaceDirectoryAccess extends Base {
  type: 'submit_workspace_directory_access';
  sessionId: string;
  requestActionId: string;
  accept: boolean;
  directory?: { deviceId: string; name: string; path: string };
}

export interface ResolveLocalExecutionApproval extends Base {
  type: 'resolve_local_execution_approval';
  sessionId: string;
  requestId: string;
  resolution: 'approve' | 'deny' | string;
  targetActionEventId?: string;
}

export interface ConfirmLocalTerminalExecution extends Base {
  type: 'confirm_local_terminal_execution';
  sessionId: string;
  actionId: string;
  allow: boolean;
}

export type PermissionMode = 'ask_for_approval' | 'approve_for_me' | 'full_access';

export interface ChangeLocalPermissionMode extends Base {
  type: 'change_local_permission_mode';
  sessionId: string;
  mode: PermissionMode;
}

export interface SetWorkspaceWorkingDirectory extends Base {
  type: 'set_workspace_working_directory';
  sessionId: string;
  path: string;
  deviceId?: string;
}

export interface ChangeTaskMode extends Base {
  type: 'change_task_mode';
  sessionId: string;
  taskMode: TaskMode;
}

export interface MessageQueueAction extends Base {
  type: 'message_queue_action';
  sessionId: string;
  action: 'pause' | 'resume' | 'clear' | string;
}

export interface ChangeQueue extends Base {
  type: 'change_queue';
  sessionId: string;
  queueMode: string;
}

export interface CancelQueue extends Base {
  type: 'cancel_queue';
  sessionId: string;
  queueId?: string;
}

export interface CascadeSteerInterrupt extends Base {
  type: 'cascade_steer_interrupt';
  sessionId: string;
  message?: string;
}

export interface ConfirmCascadeWorkflow extends Base {
  type: 'confirm_cascade_workflow';
  sessionId: string;
  jobId: string;
  action: 'confirm' | 'cancel' | string;
}

export interface KillCascadeJob extends Base {
  type: 'kill_cascade_job';
  sessionId: string;
  jobId: string;
}

export interface KillCascadeJobGroup extends Base {
  type: 'kill_cascade_job_group';
  sessionId: string;
  groupId: string;
}

export interface FollowUpContinue extends Base {
  type: 'follow_up_continue';
  sessionId: string;
  suggestionIndex?: number;
}

export interface FollowUpEnd extends Base {
  type: 'follow_up_end';
  sessionId: string;
}

export interface NewSessionWithContext extends Base {
  type: 'new_session_with_context';
  sessionId: string;
  sourceSessionId: string;
  contextEventIds?: string[];
}

export interface GetDesktopDevices extends Base {
  type: 'get_desktop_devices';
  sessionId?: string;
}

export interface EnableDeviceSandbox extends Base {
  type: 'enable_device_sandbox';
  sessionId: string;
  deviceId: string;
  enabled: boolean;
}

export interface StartSandbox extends Base {
  type: 'start_sandbox';
  sessionId: string;
  deviceId?: string;
}

export interface ResetSandbox extends Base {
  type: 'reset_sandbox';
  sessionId: string;
  deviceId?: string;
}

export interface RetryUpload extends Base {
  type: 'retry_upload';
  sessionId: string;
  attachmentId: string;
}

export interface ConfirmDeploy extends Base {
  type: 'confirm_deploy';
  sessionId: string;
  deployActionId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface SwitchDeployVersion extends Base {
  type: 'switch_deploy_version';
  sessionId: string;
  deployActionId: string;
  version: string;
}

export interface ConfirmGmailMessage extends Base {
  type: 'confirm_gmail_message';
  sessionId: string;
  gmailSendActionId: string;
  status: 'confirm' | 'save_draft' | 'cancel' | string;
}

export interface ConfirmOutlookMailMessage extends Base {
  type: 'confirm_outlook_mail_message';
  sessionId: string;
  outlookMailActionId: string;
  status: 'confirm' | 'save_draft' | 'cancel' | string;
}

export interface ConfirmGoogleCalendarCreate extends Base {
  type: 'confirm_google_calendar_create';
  sessionId: string;
  calendarActionId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ConfirmGoogleCalendarUpdate extends Base {
  type: 'confirm_google_calendar_update';
  sessionId: string;
  calendarActionId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ConfirmGoogleCalendarDelete extends Base {
  type: 'confirm_google_calendar_delete';
  sessionId: string;
  calendarActionId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ConfirmOutlookCalendarCreate extends Base {
  type: 'confirm_outlook_calendar_create';
  sessionId: string;
  calendarActionId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ConfirmOutlookCalendarUpdate extends Base {
  type: 'confirm_outlook_calendar_update';
  sessionId: string;
  calendarActionId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ConfirmOutlookCalendarDelete extends Base {
  type: 'confirm_outlook_calendar_delete';
  sessionId: string;
  calendarActionId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ConfirmShopifyDelete extends Base {
  type: 'confirm_shopify_delete';
  sessionId: string;
  shopifyActionId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ConfirmDataControl extends Base {
  type: 'confirm_data_control';
  sessionId: string;
  dataControlActionId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ConfirmConnectorReOauth extends Base {
  type: 'confirm_connector_re_oauth';
  sessionId: string;
  connectorUid: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ConfirmSessionConfigSuggestion extends Base {
  type: 'confirm_session_config_suggestion';
  sessionId: string;
  suggestionActionId: string;
  status: 'confirm' | 'cancel' | 'modify' | string;
  modifications?: Record<string, unknown>;
}

export interface ConfirmMessageSuggestedAction extends Base {
  type: 'confirm_message_suggested_action';
  sessionId: string;
  suggestedActionId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ConfirmSubmitPlan extends Base {
  type: 'confirm_submit_plan';
  sessionId: string;
  planId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ConfirmSwitchToQualityMode extends Base {
  type: 'confirm_switch_to_quality_mode';
  sessionId: string;
  generationId?: string;
  mode: string;
}

export interface ConfirmTouchpointAction extends Base {
  type: 'confirm_touchpoint_action';
  sessionId: string;
  touchpointActionId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ConfirmVideoGenerationOffer extends Base {
  type: 'confirm_video_generation_offer';
  sessionId: string;
  offerActionId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ReplyVideoGenerationApproval extends Base {
  type: 'reply_video_generation_approval';
  sessionId: string;
  generationId: string;
  status: 'approve' | 'reject' | string;
}

export interface RespondMediaUseConfirmation extends Base {
  type: 'respond_media_use_confirmation';
  sessionId: string;
  confirmationActionId: string;
  allow: boolean;
}

export interface ConfirmWebdevFeature extends Base {
  type: 'confirm_webdev_feature';
  sessionId: string;
  featureActionId: string;
  status: 'confirm' | 'cancel' | string;
}

export interface ConfirmWebdevMode extends Base {
  type: 'confirm_webdev_mode';
  sessionId: string;
  modeActionId: string;
  mode: string;
}

export interface SubmitSecretsForWebdev extends Base {
  type: 'submit_secrets_for_webdev';
  sessionId: string;
  webdevActionId: string;
  secrets: Record<string, string>;
}

export interface RefreshAppDevServer extends Base {
  type: 'refresh_app_dev_server';
  sessionId: string;
  projectId?: string;
}

export interface ApplyWebpageEdits extends Base {
  type: 'apply_webpage_edits';
  sessionId: string;
  editsActionId: string;
  edits: Record<string, unknown>;
}

export interface CreateGitRepo extends Base {
  type: 'create_git_repo';
  sessionId: string;
  projectId?: string;
  repoName?: string;
}

export interface CheckGitSyncStatus extends Base {
  type: 'check_git_sync_status';
  sessionId: string;
  projectId?: string;
}

export interface SelectMyBrowser extends Base {
  type: 'select_my_browser';
  sessionId: string;
  browserSelectionId: string;
}

export interface ReselectMyBrowser extends Base {
  type: 'reselect_my_browser';
  sessionId: string;
  browserSelectionId: string;
}

export interface SkipMyBrowser extends Base {
  type: 'skip_my_browser';
  sessionId: string;
  browserSelectionId: string;
}

export interface ReplyNewTaskSuggestion extends Base {
  type: 'reply_new_task_suggestion';
  sessionId: string;
  suggestionEventId: string;
  action: 'accept' | 'reject' | string;
}

export interface ReplyApiCreditNotice extends Base {
  type: 'reply_api_credit_notice';
  sessionId: string;
  noticeActionId: string;
  action: 'ack' | 'dismiss' | string;
}

export interface ReplyManusApiAccessApproval extends Base {
  type: 'reply_manus_api_access_approval';
  sessionId: string;
  approvalActionId: string;
  action: 'approve' | 'reject' | string;
}

export interface RefundQuota extends Base {
  type: 'refund_quota';
  sessionId: string;
  quotaActionId: string;
}

export interface InsufficientFeatureQuotaAction extends Base {
  type: 'insufficient_feature_quota_action';
  sessionId: string;
  actionId: string;
  action: 'upgrade' | 'continue' | 'cancel' | string;
}

export interface UserCreditFallbackOptIn extends Base {
  type: 'user_credit_fallback_opt_in';
  sessionId: string;
  optInActionId: string;
  optIn: boolean;
}

export interface ChangeScheduleTaskRunMode extends Base {
  type: 'change_schedule_task_run_mode';
  sessionId: string;
  scheduleId: string;
  runMode: string;
}

export interface ForceContinueMapReduce extends Base {
  type: 'force_continue_map_reduce';
  sessionId: string;
  jobId: string;
}

export interface GetMapReduceSubInfo extends Base {
  type: 'get_map_reduce_sub_info';
  sessionId: string;
  jobId: string;
  subSessionId?: string;
}

export interface ResumeMapReduce extends Base {
  type: 'resume_map_reduce';
  sessionId: string;
  jobId: string;
}

export interface RetryMapReduceSubtask extends Base {
  type: 'retry_map_reduce_subtask';
  sessionId: string;
  jobId: string;
  subSessionId: string;
}

export interface SubmitSubtaskCard extends Base {
  type: 'submit_subtask_card';
  sessionId: string;
  jobId: string;
  subSessionId: string;
  result: Record<string, unknown>;
}

export interface AddonWidgetNotify extends Base {
  type: 'addon_widget_notify';
  sessionId: string;
  widgetId: string;
  eventName: string;
  payload?: Record<string, unknown>;
}

export interface PublishInstagramMessage extends Base {
  type: 'publish_instagram_message';
  sessionId: string;
  instagramActionId: string;
  content: string;
}

export interface ConfirmMetaAdAccountSelection extends Base {
  type: 'confirm_meta_ad_account_selection';
  sessionId: string;
  metaActionId: string;
  accountId: string;
}

export interface ConfirmMetaMarketingMode extends Base {
  type: 'confirm_meta_marketing_mode';
  sessionId: string;
  metaActionId: string;
  mode: string;
}

export interface UserLeaveVideoCampaign extends Base {
  type: 'user_leave_video_campaign';
  sessionId: string;
  campaignId: string;
}

/** The complete set of client → server message types observed in the renderer. */
export type ClientMessage =
  | JoinSession
  | LeaveSession
  | UserMessage
  | StopSession
  | SubmitWorkspaceDirectoryAccess
  | ResolveLocalExecutionApproval
  | ConfirmLocalTerminalExecution
  | ChangeLocalPermissionMode
  | SetWorkspaceWorkingDirectory
  | ChangeTaskMode
  | MessageQueueAction
  | ChangeQueue
  | CancelQueue
  | CascadeSteerInterrupt
  | ConfirmCascadeWorkflow
  | KillCascadeJob
  | KillCascadeJobGroup
  | FollowUpContinue
  | FollowUpEnd
  | NewSessionWithContext
  | GetDesktopDevices
  | EnableDeviceSandbox
  | StartSandbox
  | ResetSandbox
  | RetryUpload
  | ConfirmDeploy
  | SwitchDeployVersion
  | ConfirmGmailMessage
  | ConfirmOutlookMailMessage
  | ConfirmGoogleCalendarCreate
  | ConfirmGoogleCalendarUpdate
  | ConfirmGoogleCalendarDelete
  | ConfirmOutlookCalendarCreate
  | ConfirmOutlookCalendarUpdate
  | ConfirmOutlookCalendarDelete
  | ConfirmShopifyDelete
  | ConfirmDataControl
  | ConfirmConnectorReOauth
  | ConfirmSessionConfigSuggestion
  | ConfirmMessageSuggestedAction
  | ConfirmSubmitPlan
  | ConfirmSwitchToQualityMode
  | ConfirmTouchpointAction
  | ConfirmVideoGenerationOffer
  | ReplyVideoGenerationApproval
  | RespondMediaUseConfirmation
  | ConfirmWebdevFeature
  | ConfirmWebdevMode
  | SubmitSecretsForWebdev
  | RefreshAppDevServer
  | ApplyWebpageEdits
  | CreateGitRepo
  | CheckGitSyncStatus
  | SelectMyBrowser
  | ReselectMyBrowser
  | SkipMyBrowser
  | ReplyNewTaskSuggestion
  | ReplyApiCreditNotice
  | ReplyManusApiAccessApproval
  | RefundQuota
  | InsufficientFeatureQuotaAction
  | UserCreditFallbackOptIn
  | ChangeScheduleTaskRunMode
  | ForceContinueMapReduce
  | GetMapReduceSubInfo
  | ResumeMapReduce
  | RetryMapReduceSubtask
  | SubmitSubtaskCard
  | AddonWidgetNotify
  | PublishInstagramMessage
  | ConfirmMetaAdAccountSelection
  | ConfirmMetaMarketingMode
  | UserLeaveVideoCampaign;

// ---------- server → client ----------

/** Every chat-socket frame from the server is this wrapper [O-RT]. */
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
  contents?: (
    | { type: 'text'; value: string }
    | { type: 'attachment'; attachment: ServerAttachment }
  )[];
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
  tasks: {
    status: 'doing' | 'done' | (string & {});
    title: string;
    startedAt: number;
  }[];
}

export interface NewPlanStepEvent extends ChatEventBase {
  type: 'newPlanStep';
  stepId: string;
  title: string;
}

export interface LiveStatusEvent extends ChatEventBase {
  type: 'liveStatus';
  text: string;
}

export type ToolDetail =
  | {
      terminal: {
        shellId: string;
        action: 'execute';
        command: string;
        output?: string[];
        outputType?: 'append';
        finished?: boolean;
      };
    }
  | {
      textEditor: {
        action: 'read' | 'write' | 'update';
        path: string;
        content?: string;
        oldContent?: string;
      };
    }
  | {
      search: {
        queries: string[];
        results: {
          title: string;
          link: string;
          snippet: string;
          favicon?: string;
        }[];
      };
    }
  | {
      webpageExtract: {
        action: 'extract';
        url: string;
        markdown: string;
        truncated: boolean;
      };
    }
  | {
      mcp: {
        server: string;
        tool: string;
        primitive: 'tool';
        action: 'get' | 'call';
        connectorName: string;
        argumentsPreview?: string;
        resultPreview?: string;
      };
    }
  | {
      suggestion: {
        commands: {
          content: string;
          commandType: 'followup_requirement' | (string & {});
        }[];
      };
    };

export interface ToolUsedEvent extends ChatEventBase {
  type: 'toolUsed';
  tool: ToolName;
  actionId: string;
  status: ToolStatus;
  planStepId?: string;
  brief: string;
  description?: string;
  message?: { action: string; param?: Record<string, unknown> };
  argumentsDetail?: ToolDetail;
  detail?: ToolDetail;
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
  mountedFolder: {
    deviceId: string;
    folderPath: string;
    folderName: string;
    status: 'mounted' | (string & {});
  };
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
    deviceInfo: {
      clientOS: 'windows' | 'macos' | 'linux' | (string & {});
      clientVersion: string;
      mountLayout: 'device-scoped';
      locale: string;
    };
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

export interface FolderAccessRequestEvent extends ChatEventBase {
  type: 'folderAccessRequest';
  requestId: string;
  path: string;
  access: 'read' | 'write';
}

export interface WorkspaceDirectoryAccessRequest extends ChatEventBase {
  type: 'workspaceDirectoryAccessRequest';
  actionId: string;
  deviceId?: string;
  deviceName?: string;
  environmentId?: string;
  purpose?: 'access' | 'switch' | string;
  intent?: 'switch_device' | string;
  requestedPath?: string;
  stepId?: string;
}

export interface WorkspaceDirectoryAccessResult extends ChatEventBase {
  type: 'workspaceDirectoryAccessResult';
  requestActionId: string;
  success: boolean;
  cancelled?: boolean;
  error?: string;
}

export interface LocalExecutionApprovalRequested extends ChatEventBase {
  type: 'localExecutionApprovalRequested';
  requestId: string;
  reviewer: 'user' | 'auto';
  actionRef?: string;
  actionType?: 'terminal' | 'file' | 'workspace';
  summary?: string;
  purpose?: string;
  detail:
    | { kind: 'file'; operation: string; path: string }
    | {
        kind: 'terminal';
        command: string;
        cwd?: string;
        justification?: string;
        declaredNetwork?: boolean;
        writablePaths?: string[];
        requireEscalated?: boolean;
        flaggedReason?: string;
      }
    | {
        kind: 'workspace';
        intent?: 'directory_access';
        deviceId: string;
        path: string;
        previousPath?: string;
        requestedPath: string;
        createIfMissing?: boolean;
      };
}

export interface LocalExecutionApprovalResolved extends ChatEventBase {
  type: 'localExecutionApprovalResolved';
  requestId: string;
  reviewer: 'user' | 'auto';
  result: 'approve' | 'deny';
}

export interface ComputerActivityEvent extends ChatEventBase {
  type: 'computerActivity';
  tool: 'browser' | string;
  actionId: string;
  environment: 'local_computer' | 'cloud';
  deviceId: string;
}

export interface ResourceAccessedEvent extends ChatEventBase {
  type: 'resourceAccessed';
  brief: string;
  resourceType: 'knowledge' | string;
  resources: { id: string; title: string }[];
}

export interface DeviceAttachmentUploadNotify extends ChatEventBase {
  type: 'deviceAttachmentUploadNotify';
  targetEventId: string;
  path: string;
  status: 'done' | 'failed';
  url: string;
  contentType: string;
  contentLength: number;
}

export interface DeviceWorkspaceGitStatus extends ChatEventBase {
  type: 'deviceWorkspaceGitStatus';
  noPersistent: true;
  workspaceGit: {
    deviceId: string;
    rootId: string;
    folderPath: string;
    git: {
      branch: string;
      detached: boolean;
      dirtyFiles: number;
      additions: number;
      deletions: number;
      ahead: number;
      behind: number;
      hasUpstream: boolean;
    };
    collectedAt: number;
  };
}

export type ChatEvent =
  | ChatMessageEvent
  | ChatDeltaEvent
  | StatusUpdateEvent
  | QueueStatusChangeEvent
  | PlanUpdateEvent
  | NewPlanStepEvent
  | LiveStatusEvent
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
  | ComputerActivityEvent
  | ResourceAccessedEvent
  | DeviceAttachmentUploadNotify
  | DeviceWorkspaceGitStatus;

export type ServerMessage =
  | ServerEnvelope
  | { type: 'session_write_access'; sessionId: string; writable: boolean };

/** Notifier socket (path /notifier-v2-socket-io) uses socket.io event "notification" [O-RT] */
export interface NotifierNotification {
  name: 'automation_session_read' | 'session_new_message' | 'session_info_update' | 'credits_costed' | (string & {});
  data: Record<string, unknown>;
}
