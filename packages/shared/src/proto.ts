/**
 * TypeScript shapes for the MVP protobuf messages per BUILD_SPEC §7.1.
 * Fields use proto3-JSON camelCase naming as the Connect JSON client expects.
 */

export enum SessionStatus {
  SESSION_STATUS_UNSPECIFIED = 0,
  SESSION_STATUS_CREATED = 1,
  SESSION_STATUS_ARCHIVED = 2,
  SESSION_STATUS_DELETED = 3,
  SESSION_STATUS_WAITING = 5,
  SESSION_STATUS_RUNNING = 6,
  SESSION_STATUS_STOPPED = 7,
  SESSION_STATUS_ERROR = 8,
  SESSION_STATUS_IN_QUEUE = 9,
}

export enum AgentTaskMode {
  AGENT_TASK_MODE_UNSPECIFIED = 0,
  AGENT_TASK_MODE_STANDARD = 1,
  AGENT_TASK_MODE_HIGH_EFFORT = 2,
}

export interface Timestamp {
  seconds: string;
  nanos?: number;
}

export interface AgentSession {
  uid: string;
  userId: string;
  title: string;
  icon: string;
  lastMessageTime?: Timestamp;
  lastDisplayMessage: string;
  lastReadAt?: Timestamp;
  status: SessionStatus | string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  unreadMessageCount: number;
  isFavorite: boolean;
  isShared: boolean;
  agentTaskMode: AgentTaskMode | string;
  costedCredits: number;
  projectUid?: string;
  isArchived?: boolean;
  pined?: boolean;
  desktopFolderPath?: string;
  hasRunningBackgroundJobs?: boolean;
  isFollowed: boolean;
}

export interface ListSessionsRequest {
  limit?: number;
  offset?: number;
  keyword?: string;
  status?: (SessionStatus | string)[];
  isFavorite?: boolean;
  projectUid?: string;
  isArchived?: boolean;
  includeEmptyTasks?: boolean;
  desktopDeviceId?: string;
  desktopFolderPath?: string;
}

export interface ListSessionsResponse {
  sessions: AgentSession[];
  hasNext: boolean;
  total: string;
  nextCursor: string;
}

export interface GetSessionRequest {
  sessionUid: string;
  includeEmptyTasks?: boolean;
}

export interface GetSessionResponse {
  session: AgentSession;
  runtime?: Record<string, unknown>;
}

export interface UpdateSessionRequest {
  sessionUid: string;
  title?: string;
  icon?: string;
  status?: SessionStatus | string;
}

export interface DeleteSessionRequest {
  sessionUid: string;
}

export interface FavoriteSessionRequest {
  sessionUid: string;
  note?: string;
}

export interface Project {
  uid: string;
  name: string;
  description?: string;
  logo?: string;
  instruction?: string;
  sessions: AgentSession[];
  sessionCount: string;
  isPinned: boolean;
  isFavorite: boolean;
  lastActivityAt?: Timestamp;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export enum ProjectFileType {
  PROJECT_FILE_TYPE_UNSPECIFIED = 0,
}

export interface ProjectFile {
  uid: string;
  filename: string;
  fileSize: string;
  cndUrl: string;
  fileType: ProjectFileType | string;
  linkUrl: string;
  createdAt?: Timestamp;
}

export enum SessionFileStage {
  SESSION_FILE_STAGE_UNSPECIFIED = 0,
}

export enum SessionFileType {
  SESSION_FILE_TYPE_UNSPECIFIED = 0,
}

export interface SessionFileItem {
  sandboxPath: string;
  fileUrl: string;
  fileStage?: SessionFileStage | string;
  fileType?: SessionFileType | string;
  sessionUid: string;
  eventId: string;
  displayName?: string;
}

export interface ExchangeTokenByCodeRequest {
  token: string;
}

export interface ExchangeTokenByCodeResponse {
  token: string;
}

export interface UserInfoResponse {
  userId: string;
  email: string;
  firstname: string;
  lastname: string;
  displayname: string;
  nickname: string;
  avatar: string;
  uid: string;
  concurrentSessions: number;
  membershipVersion: string;
}

export interface GetAvailableCreditsResponse {
  totalCredits: number;
  freeCredits: number;
  periodicCredits: number;
  addonCredits: number;
  refreshCredits: number;
  maxRefreshCredits: number;
  nextRefreshTime?: Timestamp;
}

export interface GenerateTempAuthCodeRequest {
  // empty
}

export interface GenerateTempAuthCodeResponse {
  token: string;
}

export interface EnsureDeviceIdentityRequest {
  deviceId: string;
  deviceCredential?: string;
}

export interface EnsureDeviceIdentityResponse {
  status: string;
  deviceId?: string;
  deviceCredential?: string;
}
