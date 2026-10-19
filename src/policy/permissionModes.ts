/**
 * Local permission modes, model/effort menus and folder-grant policy.
 *
 * This module is intentionally free of UI and transport concerns so it can be
 * used by the protocol adapter (A1), the desktop operator (A4/A9) and tests.
 */
import path from "node:path";

// ----------------------------------------------------------------------------
// Permission modes
// ----------------------------------------------------------------------------

export type LocalPermissionMode = "ask_for_approval" | "approve_for_me" | "full_access";

export const LOCAL_PERMISSION_MODES: LocalPermissionMode[] = [
  "ask_for_approval",
  "approve_for_me",
  "full_access",
];

export const DEFAULT_PERMISSION_MODE: LocalPermissionMode = "approve_for_me";

export function isLocalPermissionMode(value: unknown): value is LocalPermissionMode {
  return typeof value === "string" && (LOCAL_PERMISSION_MODES as string[]).includes(value);
}

export interface PermissionModeInfo {
  mode: LocalPermissionMode;
  title: string;
  titleAr: string;
  description: string;
  descriptionAr: string;
  icon: "hand" | "shield-check" | "shield-alert";
  isDangerous: boolean;
}

export const PERMISSION_MODE_INFO: Record<LocalPermissionMode, PermissionModeInfo> = {
  ask_for_approval: {
    mode: "ask_for_approval",
    title: "Ask for approval",
    titleAr: "اطلب الموافقة",
    description: "Always asks for approval before local actions.",
    descriptionAr: "يطلب الموافقة دائمًا قبل الإجراءات المحلية.",
    icon: "hand",
    isDangerous: false,
  },
  approve_for_me: {
    mode: "approve_for_me",
    title: "Approve for me",
    titleAr: "الموافقة عني",
    description: "Reviews and auto-approves safe local actions.",
    descriptionAr: "تراجع الموافقة التلقائية على الإجراءات المحلية الآمنة.",
    icon: "shield-check",
    isDangerous: false,
  },
  full_access: {
    mode: "full_access",
    title: "Full access",
    titleAr: "وصول كامل",
    description: "Runs local actions without approval.",
    descriptionAr: "تشغيل الإجراءات المحلية دون موافقة.",
    icon: "shield-alert",
    isDangerous: true,
  },
};

// ----------------------------------------------------------------------------
// Folder grants
// ----------------------------------------------------------------------------

export interface FolderGrant {
  /** Absolute, normalized path on the local filesystem. */
  path: string;
  /** 'always' grants persist; 'once' grants are consumed after the first use. */
  mode: "always" | "once";
  grantedAt: number;
}

/** Return a normalized absolute path; callers should run realpath first. */
export function normalizePath(input: string): string {
  return path.normalize(path.resolve(input));
}

/** True when `target` is equal to or inside one of the granted folders. */
export function isInsideGrantedFolder(target: string, grants: ReadonlyArray<FolderGrant>): boolean {
  const normalized = normalizePath(target);
  for (const grant of grants) {
    const root = normalizePath(grant.path);
    if (normalized === root || normalized.startsWith(root + path.sep)) return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// Action review
// ----------------------------------------------------------------------------

export type LocalActionKind = "read" | "write" | "terminal" | "workspace" | "network";

export interface ActionReviewInput {
  mode: LocalPermissionMode;
  action: LocalActionKind;
  /** Absolute target path, when the action touches the filesystem. */
  targetPath?: string;
  /** Set when the tool declares it needs network egress. */
  requiresNetwork?: boolean;
  /** Set when a safety rule flagged the action (e.g. rm -rf /). */
  flaggedReason?: string;
  /** Currently granted folders. */
  grants?: ReadonlyArray<FolderGrant>;
}

export interface ActionReview {
  needsApproval: boolean;
  reviewer: "user" | "auto";
  reason?: string;
  reasonAr?: string;
}

/**
 * Decide whether a local action needs explicit user approval.
 *
 * Rules (mirroring BUILD_SPEC §7.2.2 / §9.4):
 * - full_access: never asks.
 * - In-workspace reads and writes are safe for ask_for_approval and approve_for_me.
 * - Writes outside granted folders, network escalation, flagged commands, and
 *   workspace directory access require approval.
 * - approve_for_me auto-approves safe actions; ask_for_approval asks for
 *   anything that is not a safe in-workspace read/write.
 */
export function reviewLocalAction(input: ActionReviewInput): ActionReview {
  if (input.mode === "full_access") {
    return { needsApproval: false, reviewer: "auto" };
  }

  // Anything explicitly flagged by a safety rule must be reviewed by the user.
  if (input.flaggedReason) {
    return {
      needsApproval: true,
      reviewer: "user",
      reason: `Flagged by local safety rule: ${input.flaggedReason}`,
      reasonAr: `مُعلّق بسبب قاعدة السلامة المحلية: ${input.flaggedReason}`,
    };
  }

  // Network escalation outside the workspace always needs explicit approval.
  if (input.requiresNetwork) {
    return {
      needsApproval: true,
      reviewer: "user",
      reason: "This action requires network access.",
      reasonAr: "هذا الإجراء يتطلب وصولاً إلى الشبكة.",
    };
  }

  // Workspace-level directory access is always a user decision.
  if (input.action === "workspace") {
    return {
      needsApproval: true,
      reviewer: "user",
      reason: "Folder access request outside granted folders.",
      reasonAr: "طلب وصول إلى مجلد خارج المجلدات المسموح بها.",
    };
  }

  const safeInWorkspace =
    input.targetPath !== undefined &&
    isInsideGrantedFolder(input.targetPath, input.grants ?? []);

  // Terminal commands that are not inside a granted folder need approval.
  if (input.action === "terminal") {
    if (safeInWorkspace) {
      return { needsApproval: false, reviewer: "auto" };
    }
    return {
      needsApproval: true,
      reviewer: "user",
      reason: "Command runs outside the granted workspace.",
      reasonAr: "الأمر يعمل خارج مساحة العمل المسموح بها.",
    };
  }

  // Reads/writes inside granted folders are safe.
  if ((input.action === "read" || input.action === "write") && safeInWorkspace) {
    return { needsApproval: false, reviewer: "auto" };
  }

  // Everything else (outside writes, unknown paths, etc.) requires approval.
  return {
    needsApproval: true,
    reviewer: "user",
    reason: input.action === "read" ? "Read access outside granted folders." : "Write access outside granted folders.",
    reasonAr: input.action === "read" ? "وصول للقراءة خارج المجلدات المسموح بها." : "وصول للكتابة خارج المجلدات المسموح بها.",
  };
}

// ----------------------------------------------------------------------------
// Effort panel
// ----------------------------------------------------------------------------

export type EffortLevel = "medium" | "high" | "extra" | "ultra";

export const EFFORT_LEVELS: EffortLevel[] = ["medium", "high", "extra", "ultra"];

export const DEFAULT_EFFORT_LEVEL: EffortLevel = "high";

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as string[]).includes(value);
}

export interface EffortBudgets {
  /** Max tool/model steps for the main agent loop. */
  stepBudget: number;
  /** Verification attempts budget. */
  verifyBudget: number;
  /** Reflection / replan attempts budget. */
  reflectionBudget: number;
}

/**
 * Map the UI effort panel (Medium/High/Extra/Ultra) to execution budgets.
 *
 * BUILD_SPEC §5.9 S16 leaves exact numbers as a design decision; the scale
 * mirrors Loam's existing {low:16, medium:40, high:64, max:80} effort field
 * while adding an Ultra tier for Max mode.
 */
export function effortBudgets(level: EffortLevel): EffortBudgets {
  switch (level) {
    case "medium":
      return { stepBudget: 40, verifyBudget: 1, reflectionBudget: 1 };
    case "high":
      return { stepBudget: 64, verifyBudget: 2, reflectionBudget: 2 };
    case "extra":
      return { stepBudget: 80, verifyBudget: 3, reflectionBudget: 3 };
    case "ultra":
      return { stepBudget: 120, verifyBudget: 4, reflectionBudget: 4 };
  }
}

export interface EffortOption {
  level: EffortLevel;
  label: string;
  labelAr: string;
}

export const EFFORT_OPTIONS: EffortOption[] = [
  { level: "medium", label: "Medium", labelAr: "متوسط" },
  { level: "high", label: "High", labelAr: "عالٍ" },
  { level: "extra", label: "Extra", labelAr: "إضافي" },
  { level: "ultra", label: "Ultra", labelAr: "فائق" },
];

// ----------------------------------------------------------------------------
// Model menu → Loam run profile
// ----------------------------------------------------------------------------

export type AgentMode = "max" | "standard" | "lite" | "flex";

export const AGENT_MODES: AgentMode[] = ["max", "standard", "lite", "flex"];

export const DEFAULT_AGENT_MODE: AgentMode = "standard";

export function isAgentMode(value: unknown): value is AgentMode {
  return typeof value === "string" && (AGENT_MODES as string[]).includes(value);
}

export interface ModelMenuItem {
  mode: AgentMode;
  title: string; // English source key per BUILD_SPEC §5.8
  titleAr: string;
  description: string;
  descriptionAr: string;
}

export const MODEL_MENU_ITEMS: ModelMenuItem[] = [
  {
    mode: "max",
    title: "{product} 2.0 Max",
    titleAr: "{product} 2.0 Max",
    description: "High-performance agent designed for complex tasks.",
    descriptionAr: "وكيل عالي الأداء مصمم للمهام المعقدة.",
  },
  {
    mode: "standard",
    title: "{product} 2.0",
    titleAr: "{product} 2.0",
    description: "Versatile agent capable of most tasks.",
    descriptionAr: "وكيل متعدد الاستخدامات قادر على معظم المهام.",
  },
  {
    mode: "lite",
    title: "{product} 2.0 Lite",
    titleAr: "{product} 2.0 Lite",
    description: "A lightweight agent for everyday tasks.",
    descriptionAr: "وكيل خفيف للمهام اليومية.",
  },
  {
    mode: "flex",
    title: "{product} Flex",
    titleAr: "{product} Flex",
    description: "Bring your own model API key to power {product}.",
    descriptionAr: "استخدم مفتاح API الخاص بنموذجك لتشغيل {product}.",
  },
];

export interface LoamRunProfile {
  /** Loam mode id from src/modes/catalog.ts */
  loamMode: string;
  /** Loam effort level sent in extData / runControl. */
  effort: EffortLevel;
  /**
   * Optional explicit model identifier. When undefined the caller should use
   * the default configured model. Flex mode returns the user-supplied model id.
   */
  model?: string;
}

export interface AgentModeMappingOptions {
  /** User-supplied Flex model id. */
  flexModelId?: string;
  /** Default model to use for Max/Standard/Lite when no explicit id is set. */
  defaultModel?: string;
  /** Lighter fallback model for Lite. */
  liteModel?: string;
}

/**
 * Map the Manus-style model menu to a concrete Loam run profile.
 *
 * The mapping is a rebuild design decision (BUILD_SPEC §7.2.3 / §8.5):
 * - Max → build mode, ultra effort.
 * - Standard → build mode, high effort.
 * - Lite → ask mode (read-only, lightweight), medium effort.
 * - Flex → build mode, high effort, user-supplied model id.
 */
export function mapAgentModeToLoam(
  mode: AgentMode,
  options: AgentModeMappingOptions = {},
): LoamRunProfile {
  switch (mode) {
    case "max":
      return { loamMode: "build", effort: "ultra", model: options.defaultModel };
    case "standard":
      return { loamMode: "build", effort: "high", model: options.defaultModel };
    case "lite":
      return { loamMode: "ask", effort: "medium", model: options.liteModel ?? options.defaultModel };
    case "flex":
      return { loamMode: "build", effort: "high", model: options.flexModelId };
  }
}

// ----------------------------------------------------------------------------
// User message extData helpers
// ----------------------------------------------------------------------------

export interface UserMessageExtData {
  mode?: string;
  effort?: string;
  localPermissionMode?: LocalPermissionMode;
  executionTarget?: { kind: "sandbox" | "desktop" };
  desktopBinding?: { deviceId: string; folderPath: string; folderName?: string };
}

/** Build the `extData.mode` / `extData.effort` payload from menu selections. */
export function buildRunExtData(
  mode: AgentMode,
  effort: EffortLevel,
  permissionMode: LocalPermissionMode,
): UserMessageExtData {
  const profile = mapAgentModeToLoam(mode);
  return {
    mode: profile.loamMode,
    effort,
    localPermissionMode: permissionMode,
    executionTarget: { kind: "desktop" },
  };
}
