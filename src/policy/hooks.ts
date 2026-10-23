import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR } from "../config.js";

/** Every lifecycle event Loam can notify external hook commands about.
 *  This mirrors the broad Claude Code hook surface (tool use, prompt
 *  submission, turn stop, session boundaries, compaction and subagents)
 *  without copying any proprietary wording or implementation. */
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SessionStart"
  | "SessionEnd"
  | "PreCompact"
  | "SubagentStart"
  | "SubagentStop";

export interface HookRule {
  /** Regex or exact tool name (e.g. "file_write|file_edit"). Empty = all tools. */
  matcher: string;
  /** Shell command to run in the workspace directory. */
  command: string;
  /** For PreToolUse: block the tool call when the hook exits non-zero (default true). */
  blockOnFail?: boolean;
  /** Timeout in milliseconds (default 20000). */
  timeoutMs?: number;
}

export interface HooksConfig {
  PreToolUse?: HookRule[];
  PostToolUse?: HookRule[];
  UserPromptSubmit?: HookRule[];
  Stop?: HookRule[];
  SessionStart?: HookRule[];
  SessionEnd?: HookRule[];
  /** Runs just before a compaction. A non-zero exit vetoes the compaction. */
  PreCompact?: HookRule[];
  SubagentStart?: HookRule[];
  SubagentStop?: HookRule[];
}

export interface HookOutcome {
  command: string;
  code: number | null;
  output: string;
  /** Parsed JSON decision object, when the hook printed one. */
  decision?: ParsedHookDecision;
}

/** Structured decision fields a hook may return as JSON on stdout.
 *  `decision: "block"` stops the guarded operation; `additionalContext`
 *  is injected into the conversation. */
export interface ParsedHookDecision {
  decision?: string;
  reason?: string;
  additionalContext?: string;
  hookSpecificOutput?: Record<string, unknown>;
}

export interface HookRunResult {
  /** True when a hook told Loam to block (JSON decision, or a PreToolUse failure). */
  blocked: boolean;
  /** Human-readable summary of hook output / block reason. */
  message: string;
  /** Context a hook asked Loam to inject into the conversation. */
  additionalContext: string;
  outcomes: HookOutcome[];
}

/** Tag that wraps hook-provided context so it is distinguishable from user input
 *  and can never be mistaken for it by the model or the UI. */
export const HOOK_CONTEXT_TAG = "hook-context";

/** Wrap hook-provided context so it is visibly not user input. */
export function wrapHookContext(context: string): string {
  const text = context.trim();
  return text.length > 0 ? "<" + HOOK_CONTEXT_TAG + ">\n" + text + "\n</" + HOOK_CONTEXT_TAG + ">" : "";
}

const EVENT_KEYS: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "SubagentStart",
  "SubagentStop",
];

/** Events introduced by the hook expansion. These use JSON stdout decisions
 *  (block / additionalContext) and, unlike the tool events, treat exit code 2
 *  as a blocking error. */
const DECISION_EVENTS: ReadonlySet<HookEvent> = new Set([
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "SubagentStart",
  "SubagentStop",
]);

function parseRules(raw: unknown): HookRule[] {
  if (!Array.isArray(raw)) return [];
  const out: HookRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const command = typeof rec.command === "string" ? rec.command.trim() : "";
    if (!command) continue;
    const matcher = typeof rec.matcher === "string" ? rec.matcher.trim() : "";
    out.push({
      matcher,
      command,
      ...(typeof rec.blockOnFail === "boolean" ? { blockOnFail: rec.blockOnFail } : {}),
      ...(typeof rec.timeoutMs === "number" && Number.isFinite(rec.timeoutMs) ? { timeoutMs: rec.timeoutMs } : {}),
    });
  }
  return out;
}

function pushRules(config: HooksConfig, key: HookEvent, rules: HookRule[]): void {
  if (rules.length === 0) return;
  const bag = config as Record<string, HookRule[] | undefined>;
  const existing = bag[key] ?? [];
  existing.push(...rules);
  bag[key] = existing;
}

export function loadHooksConfig(workspace: string): HooksConfig {
  const files = [
    path.join(DATA_DIR, "hooks.json"),
    path.join(workspace, ".manus", "hooks.json"),
    path.join(workspace, ".claude", "hooks.json"),
  ];
  const out: HooksConfig = {};
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const key of EVENT_KEYS) pushRules(out, key, parseRules(parsed[key]));
    } catch {
      /* ignore malformed hooks file */
    }
  }
  return out;
}

export function saveWorkspaceHooks(workspace: string, config: HooksConfig): string {
  const dir = path.join(workspace, ".manus");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "hooks.json");
  const payload: Record<string, HookRule[]> = {};
  for (const key of EVENT_KEYS) payload[key] = parseRules(config[key]);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

function isToolScoped(event: HookEvent): boolean {
  return !DECISION_EVENTS.has(event);
}

function matchesTool(matcher: string, toolName: string): boolean {
  if (!matcher || matcher === "*") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

/** Extract a JSON decision object from hook stdout. Hooks may print prose and
 *  then a JSON object, so a bare parse, a per-line scan and a brace-span parse
 *  are all attempted. */
function normalizeDecision(obj: Record<string, unknown>): ParsedHookDecision {
  const out: ParsedHookDecision = {};
  if (typeof obj.decision === "string" && obj.decision.trim()) out.decision = obj.decision.trim();
  if (typeof obj.reason === "string" && obj.reason.trim()) out.reason = obj.reason.trim();
  if (typeof obj.additionalContext === "string" && obj.additionalContext.trim()) {
    out.additionalContext = obj.additionalContext;
  }
  if (obj.hookSpecificOutput && typeof obj.hookSpecificOutput === "object" && !Array.isArray(obj.hookSpecificOutput)) {
    out.hookSpecificOutput = obj.hookSpecificOutput as Record<string, unknown>;
  }
  return out;
}

function parseHookDecision(output: string): ParsedHookDecision | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return normalizeDecision(parsed);
  } catch {
    /* not a bare JSON object */
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return normalizeDecision(parsed);
    } catch {
      /* keep scanning */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return normalizeDecision(parsed);
    } catch {
      /* no JSON object */
    }
  }
  return null;
}

function argEnvName(key: string): string {
  return `MANUS_ARG_${key.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`;
}

function buildHookEnv(
  event: HookEvent,
  toolName: string,
  args: Record<string, unknown>,
  workspace: string,
): Record<string, string> {
  const env: Record<string, string> = {
    MANUS_HOOK_EVENT: event,
    MANUS_TOOL_NAME: toolName,
    MANUS_TOOL_ARGS: JSON.stringify(args).slice(0, 8000),
    MANUS_WORKSPACE: workspace,
    MANUS_FILE_PATH: typeof args.path === "string" ? args.path : "",
  };
  if (typeof args.prompt === "string") env.MANUS_PROMPT = args.prompt.slice(0, 8000);
  if (typeof args.subagent === "string") env.MANUS_SUBAGENT = args.subagent;
  if (typeof args.stopReason === "string") env.MANUS_STOP_REASON = args.stopReason;
  if (typeof args.sessionId === "string") env.MANUS_SESSION_ID = args.sessionId;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") env[argEnvName(key)] = value.slice(0, 4000);
    else if (typeof value === "number" || typeof value === "boolean") env[argEnvName(key)] = String(value);
  }
  return env;
}

function execHook(command: string, cwd: string, env: Record<string, string>, timeoutMs = 20_000): Promise<HookOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let out = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, Math.min(Math.max(timeoutMs, 1000), 120_000));
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < 16_000) out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (out.length < 16_000) out += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ command, code: 1, output: `${out}\n${String(err.message ?? err)}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command, code, output: out.trim() });
    });
  });
}

/** Like `execHook`, but feeds `stdin` to the child. */
function execHookWithStdin(
  command: string,
  cwd: string,
  env: Record<string, string>,
  stdin: string,
  timeoutMs: number,
): Promise<HookOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let out = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, Math.min(Math.max(timeoutMs, 1000), 120_000));
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < 16_000) out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (out.length < 16_000) out += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ command, code: 1, output: `${out}\n${String(err.message ?? err)}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command, code, output: out.trim() });
    });
    try {
      child.stdin?.end(stdin);
    } catch {
      /* ignore */
    }
  });
}

/** Context passed to a PreCompact hook through stdin and the environment. */
export interface PreCompactHookInput {
  /** Model whose window is being filled. */
  model: string;
  /** Configured context window size for that model. */
  window: number;
  /** Token count at which compaction triggers. */
  threshold: number;
  /** Estimated tokens in the transcript right now. */
  tokens: number;
  /** Number of messages in the transcript. */
  messages: number;
}

export interface PreCompactHookResult {
  /** True when a hook vetoed the compaction. */
  blocked: boolean;
  /** Human-readable reason, surfaced in the compaction event. */
  message: string;
  outcomes: HookOutcome[];
}

/**
 * Run the PreCompact hooks. Every rule runs (they are observers or vetoers, not
 * a tool filter); the first non-zero exit with `blockOnFail !== false` vetoes
 * the compaction. The hook receives the compaction context as JSON on stdin and
 * as `MANUS_*` environment variables.
 */
export async function runPreCompactHooks(input: PreCompactHookInput, workspace: string): Promise<PreCompactHookResult> {
  const cfg = loadHooksConfig(workspace);
  const rules = cfg.PreCompact ?? [];
  if (rules.length === 0) return { blocked: false, message: "", outcomes: [] };

  const env: Record<string, string> = {
    MANUS_HOOK_EVENT: "PreCompact",
    MANUS_WORKSPACE: workspace,
    MANUS_COMPACT_MODEL: input.model,
    MANUS_COMPACT_WINDOW: String(input.window),
    MANUS_COMPACT_THRESHOLD: String(input.threshold),
    MANUS_COMPACT_TOKENS: String(input.tokens),
    MANUS_COMPACT_MESSAGES: String(input.messages),
  };
  const stdin = JSON.stringify(input);

  const outcomes: HookOutcome[] = [];
  const notes: string[] = [];
  for (const rule of rules) {
    const res = await execHookWithStdin(rule.command, workspace, env, stdin, rule.timeoutMs ?? 20_000);
    outcomes.push(res);
    if (res.code !== 0 && rule.blockOnFail !== false) {
      return {
        blocked: true,
        message: `PreCompact hook blocked compaction (command: ${rule.command}, exit=${res.code ?? "null"})${res.output ? `\n${res.output}` : ""}`,
        outcomes,
      };
    }
    if (res.code !== 0 || res.output.length > 0) {
      notes.push(`[PreCompact hook (${rule.command}) exit=${res.code ?? 0}]${res.output ? `\n${res.output}` : ""}`);
    }
  }
  return { blocked: false, message: notes.join("\n"), outcomes };
}

/**
 * Run every hook configured for `event`. PreToolUse/PostToolUse are tool-scoped
 * and honour a rule matcher; the expanded lifecycle events carry no tool name,
 * so their matchers are ignored instead of silently disabling the hook.
 *
 * PreToolUse keeps its original contract: a non-zero exit blocks the tool
 * call unless `blockOnFail` is false. The expanded lifecycle events use JSON
 * stdout decisions instead: `{"decision":"block"}` blocks and
 * `{"additionalContext":"..."}` is returned for the caller to inject. For
 * those events an exit code of 2 is also treated as blocking, matching the
 * common hook convention.
 */
export async function runLifecycleHooks(
  event: HookEvent,
  toolName: string,
  args: Record<string, unknown>,
  workspace: string,
): Promise<HookRunResult> {
  const cfg = loadHooksConfig(workspace);
  const rules = cfg[event] ?? [];
  const matching = isToolScoped(event) ? rules.filter((r) => matchesTool(r.matcher, toolName)) : rules;
  if (matching.length === 0) return { blocked: false, message: "", additionalContext: "", outcomes: [] };

  const env = buildHookEnv(event, toolName, args, workspace);
  const outcomes: HookOutcome[] = [];
  const notes: string[] = [];
  let additionalContext = "";

  for (const rule of matching) {
    const res = await execHook(rule.command, workspace, env, rule.timeoutMs ?? 20_000);
    const decision = parseHookDecision(res.output);
    outcomes.push(decision ? { ...res, decision } : res);

    const exitBlock =
      event === "PreToolUse" ? res.code !== 0 && rule.blockOnFail !== false : DECISION_EVENTS.has(event) && res.code === 2;
    const jsonBlock = decision?.decision === "block";
    if (exitBlock || jsonBlock) {
      const reason = jsonBlock ? decision?.reason : res.code === 2 ? "hook exited with code 2 (blocking)" : undefined;
      const message =
        event === "PreToolUse" && !jsonBlock
          ? `PreToolUse hook blocked "${toolName}" (command: ${rule.command}, exit=${res.code ?? "null"})${res.output ? `\n${res.output}` : ""}`
          : `[${event} hook (${rule.command})] blocked${reason ? `: ${reason}` : ""}${!reason && res.output ? `\n${res.output}` : ""}`;
      return { blocked: true, message, additionalContext, outcomes };
    }

    if (decision?.additionalContext) {
      additionalContext += (additionalContext ? "\n" : "") + decision.additionalContext.trim();
    }
    if (res.code !== 0 || res.output.length > 0) {
      notes.push(`[${event} hook (${rule.command}) exit=${res.code ?? 0}]${res.output ? `\n${res.output}` : ""}`);
    }
  }

  return { blocked: false, message: notes.join("\n"), additionalContext, outcomes };
}
