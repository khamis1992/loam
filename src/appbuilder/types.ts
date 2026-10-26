// src/appbuilder/types.ts
// Shared types for the Loam App Builder. Pure types and constants only.
import type { ModelTier } from "../server/modelTiers.js";

export type AppRunFlavor = "quick" | "goal";

export type AppRoleId =
  | "lead"
  | "engineer"
  | "product"
  | "architect"
  | "data"
  | "research"
  | "seo";

export type AppProjectStatus =
  | "idle"
  | "clarifying"
  | "awaiting_approval"
  | "building"
  | "verifying"
  | "versioning"
  | "racing"
  | "editing"
  | "failed"
  | "stopped";

export type TemplateId = "web-app";
export type TemplateFeatureId = "fullstack" | "seo-blog";

export type AppScenario =
  | "web_app"
  | "landing_page"
  | "data_dashboard"
  | "content_site"
  | "game"
  | "tool"
  | "fullstack_app";

export type VerifyTier = "fast" | "standard" | "strict";

export interface AppProjectSettings {
  /** "auto" lets stepRouting pick per role and step. */
  defaultTier: ModelTier | "auto";
  /** Branch count last picked in the composer Race chip (§4.13.2). The chip itself is per prompt and starts off. */
  raceBranches: 2 | 3 | 4;
  verifyTier: VerifyTier;
  /** Fixed port if the user pinned one; otherwise devServer picks a free port. */
  devServerPort: number | null;
}

export interface AppProject {
  id: string;                    // "app_" + 12 lowercase base32 chars
  taskId: string;                // Loam task id that owns the workspace
  title: string;
  description: string;
  templateId: TemplateId;
  features: TemplateFeatureId[];
  /** Absolute path of the task workspace (from ensureTaskWorkspace). */
  workspaceDir: string;
  /** Workspace-relative POSIX path of the app root. Always "app". */
  appDir: "app";
  defaultFlavor: AppRunFlavor;
  status: AppProjectStatus;
  activeVersion: number | null;
  settings: AppProjectSettings;
  /** Set when the project was made by Remix (§4.7.5). */
  remixOfProjectId: string | null;
  remixOfVersion: number | null;
  /** "own" after app_add_dependency gave the project its own node_modules (§4.3.9). */
  depsMode: "shared" | "own";
  /** AI in the generated app (§4.10.4). null fields fall back to the user's default provider. */
  ai: AppAiProjectFields;
  createdAt: string;             // ISO 8601 UTC
  updatedAt: string;
}

// ---------- AI in generated apps: the user's own provider key (§4.10.4) ----------

export interface AppAiProjectFields {
  baseUrl: string | null;        // null = use the default provider
  model: string | null;          // null = use the default provider's model
  /** Optional cap set by the user, tokens per local calendar day. null = off (default). */
  dailyTokenCap: number | null;
}

/** What the UI sees. The key value never leaves the Loam server. */
export interface AppAiProviderPublic {
  baseUrl: string;               // OpenAI-compatible base URL, e.g. "https://api.x.ai/v1"
  model: string;
  hasKey: boolean;
}

export interface AppAiProjectConfig {
  /** Where the key comes from: the user's default key or a key saved for this project only. */
  keySource: "default" | "project" | "none";
  effective: AppAiProviderPublic;
  dailyTokenCap: number | null;
}

export interface AppAiUsageDay { day: string; calls: number; tokens: number }

// ---------- Goal mode: questions ----------

export type QuestionKind = "single" | "multi" | "text";

export interface QuestionOption {
  id: string;                    // "o1", "o2", ...
  label: string;                 // short label, <= 40 chars
  detail?: string;               // one sentence, <= 240 chars
}

export interface QuestionSpec {
  id: string;                    // "q1", "q2", ...
  prompt: string;                // <= 160 chars, ends with "?"
  kind: QuestionKind;
  options: QuestionOption[];     // 2..5 for single/multi, [] for text
  /** Pre-selected option ids. single: exactly 1. multi: 0..n. text: []. */
  defaultOptionIds: string[];
  allowOther: boolean;
}

export type QuestionsStatus = "pending" | "answered" | "skipped" | "expired";

export interface QuestionAnswer {
  questionId: string;
  optionIds: string[];
  otherText?: string;
  /** True when the user submitted without changing the default. */
  usedDefault: boolean;
}

export interface QuestionsCard {
  id: string;                    // "qc_" + 12 chars
  projectId: string;
  runId: string;
  title: string;
  questions: QuestionSpec[];     // 1..5
  status: QuestionsStatus;
  answers: QuestionAnswer[] | null;
  createdAt: string;
  answeredAt: string | null;
}

// ---------- Goal mode: plan ----------

export type DecisionSource = "user" | "default" | "inferred";

export interface KeyDecision {
  date: string;                  // YYYY-MM-DD in Asia/Qatar
  decision: string;
  rationale: string;
  source: DecisionSource;
}

export type PlanTaskStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";

export interface PlanTask {
  id: string;                    // "T1".."T20"
  title: string;
  role: AppRoleId;
  deps: string[];                // other PlanTask ids
  status: PlanTaskStatus;
  acceptance: string[];          // 1..6 testable statements
}

export interface PlanDocument {
  title: string;
  overview: string;              // 1..4 sentences
  scenario: AppScenario;
  templateId: TemplateId;
  features: TemplateFeatureId[];
  keyDecisions: KeyDecision[];
  constraints: string[];
  requirements: string[];
  userStories: string[];
  tasks: PlanTask[];
}

export type PlanDraftStatus = "draft" | "approved" | "declined" | "superseded";

export interface PlanDraft {
  id: string;                    // "pd_" + 12 chars
  projectId: string;
  runId: string;
  revision: number;              // 1, 2, 3 ... per project
  status: PlanDraftStatus;
  doc: PlanDocument;
  declineReason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

// ---------- Task assignment ----------

export type AssignmentStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface AppTaskAssignment {
  id: string;                    // "as_" + 12 chars
  projectId: string;
  planDraftId: string | null;    // null in Build mode
  planTaskIds: string[];         // ["T1","T2"] when bundled into one assignment
  role: AppRoleId;
  brief: string;                 // the full instruction text handed to the role
  status: AssignmentStatus;
  report: string | null;         // role's final report
  startedAt: string | null;
  finishedAt: string | null;
}

// ---------- Verify loop ----------

export type VerifyStepId =
  | "install"
  | "placeholder"
  | "design-doc"
  | "check"
  | "lint"
  | "typecheck"
  | "build"
  | "visual"
  | "contract";

export interface VerifyStepResult {
  id: VerifyStepId;
  command: string | null;        // null for visual, contract, placeholder, design-doc
  ok: boolean;
  skipped: boolean;
  durationMs: number;
  exitCode: number | null;
  /** Last 4,000 chars of combined output, secrets redacted. */
  outputTail: string;
}

export interface VerifyReport {
  id: string;                    // "vr_" + 12 chars
  projectId: string;
  runId: string;
  attempt: number;               // 1..3 within one run
  tier: VerifyTier;
  pass: boolean;
  steps: VerifyStepResult[];
  consoleErrors: number;
  screenshots: string[];         // workspace-relative paths
  visualVerdict: "pass" | "fail" | "unavailable" | "skipped";
  visualNotes: string;
  /** Absolute path of the full log on disk. Never sent to the model. */
  logPath: string;
  error: "verify_limit" | "aborted" | null;
  startedAt: string;
  finishedAt: string;
}

// ---------- Versions ----------

export type VersionSource = "build" | "restore" | "edit" | "race" | "remix";

export interface VersionFileChange {
  path: string;                  // workspace-relative POSIX
  change: "A" | "M" | "D";
}

export interface VersionUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  credits: number;
  wallMs: number;
  toolCalls: number;
}

export interface AppVersion {
  projectId: string;
  number: number;                // 1, 2, 3 ...
  title: string;                 // <= 60 chars
  summary: string;               // <= 600 chars
  commit: string;                // 40-hex git commit in the project's version repo
  parentNumber: number | null;
  source: VersionSource;
  filesChanged: VersionFileChange[];
  verifyReportId: string | null;
  usage: VersionUsage;
  /** Packages app_add_dependency installed during the run that made this version (§4.3.9). */
  addedPackages: Array<{ name: string; version: string; license: string; licenseInNoteList: boolean }>;
  createdAt: string;
}

// ---------- Preview and runtime errors ----------

export type DevServerState = "stopped" | "starting" | "ready" | "crashed";

export interface DevServerStatus {
  projectId: string;
  state: DevServerState;
  url: string | null;            // http://127.0.0.1:<port>/
  port: number | null;
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
}

export type RuntimeErrorKind = "console.error" | "unhandledrejection" | "error" | "vite" | "http";

export interface RuntimeErrorRecord {
  id: string;                    // "re_" + 12 chars
  projectId: string;
  kind: RuntimeErrorKind;
  message: string;               // <= 2,000 chars
  stack: string | null;          // <= 6,000 chars
  source: SourceLocation | null;
  url: string | null;
  count: number;                 // deduplicated occurrences
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SourceLocation {
  file: string;                  // app-relative POSIX, e.g. "src/pages/Index.tsx"
  line: number;                  // 1-based
  column: number;                // 1-based
}

// ---------- Prompt queue ----------

export type QueueItemStatus = "queued" | "sending" | "sent" | "failed" | "removed";

export interface PromptQueueItem {
  id: string;                    // "pq_" + 12 chars
  projectId: string;
  position: number;              // 0-based, dense
  content: string;
  flavor: AppRunFlavor;
  attachments: string[];         // workspace-relative paths
  status: QueueItemStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PromptQueueState {
  projectId: string;
  paused: boolean;
  items: PromptQueueItem[];
}

// ---------- Race ----------

export type RaceStatus = "running" | "scoring" | "choosing" | "promoted" | "aborted" | "failed";
export type RaceReason =
  | "unknown"
  | "already_running"
  | "queue_incompatible"
  | "budget_exceeded"
  | "worktree_failed"
  | "all_branches_failed"
  | "stateful_tool_blocked";

export interface RaceBranch {
  id: string;                    // "rb_" + 12 chars
  raceId: string;
  index: number;                 // 0..3
  model: string;                 // resolved model id (never shown raw in UI; tier label shown)
  tierLabel: string;
  worktreeDir: string;
  status: "running" | "done" | "failed" | "aborted";
  score: RaceScore | null;
  previewUrl: string | null;
  usage: VersionUsage;
}

export interface RaceScore {
  total: number;                 // 0..100
  build: number;                 // 0 or 40
  lint: number;                  // 0 or 10
  check: number;                 // 0 or 15
  visual: number;                // 0, 10 or 20
  consoleClean: number;          // 0 or 5
  requirementCoverage: number;   // 0..10
}

/** Shown in the composer before a raced prompt is sent (§4.13.2). */
export interface RaceEstimate {
  branches: 2 | 3 | 4;
  /** Median credits of the project's last 5 finished Build runs, or 10 with no history. */
  perRunCredits: number;
  /** Credits on top of a normal single run: (branches - 1) x perRunCredits + branches (one scoring call each). */
  extraCredits: number;
  /** Hard budget of the whole race: ceil(branches x 1.5 x perRunCredits). */
  maxTotalCredits: number;
  basis: "history" | "default";
  sampleRuns: number;            // 0..5
}

export interface RaceRun {
  id: string;                    // "race_" + 12 chars
  projectId: string;
  prompt: string;
  status: RaceStatus;
  reason: RaceReason | null;
  branches: RaceBranch[];
  chosenBranchId: string | null;
  createdAt: string;
  finishedAt: string | null;
}
