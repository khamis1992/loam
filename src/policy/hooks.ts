import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR } from "../config.js";

export type HookEvent = "PreToolUse" | "PostToolUse" | "PreCompact";

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
  /** Runs just before a compaction. A non-zero exit vetoes the compaction. */
  PreCompact?: HookRule[];
}

export interface HookOutcome {
  command: string;
  code: number | null;
  output: string;
}

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

export function loadHooksConfig(workspace: string): HooksConfig {
  const files = [
    path.join(DATA_DIR, "hooks.json"),
    path.join(workspace, ".manus", "hooks.json"),
    path.join(workspace, ".claude", "hooks.json"),
  ];
  const pre: HookRule[] = [];
  const post: HookRule[] = [];
  const preCompact: HookRule[] = [];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      pre.push(...parseRules(parsed.PreToolUse));
      post.push(...parseRules(parsed.PostToolUse));
      preCompact.push(...parseRules(parsed.PreCompact));
    } catch {
      /* ignore malformed hooks file */
    }
  }
  return { PreToolUse: pre, PostToolUse: post, PreCompact: preCompact };
}

export function saveWorkspaceHooks(workspace: string, config: HooksConfig): string {
  const dir = path.join(workspace, ".manus");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "hooks.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        PreToolUse: parseRules(config.PreToolUse),
        PostToolUse: parseRules(config.PostToolUse),
        PreCompact: parseRules(config.PreCompact),
      },
      null,
      2,
    ),
    "utf8",
  );
  return file;
}

function matchesTool(matcher: string, toolName: string): boolean {
  if (!matcher || matcher === "*") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
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

export async function runLifecycleHooks(
  event: HookEvent,
  toolName: string,
  args: Record<string, unknown>,
  workspace: string,
): Promise<{ blocked: boolean; message: string; outcomes: HookOutcome[] }> {
  const cfg = loadHooksConfig(workspace);
  const rules = (event === "PreToolUse" ? cfg.PreToolUse : event === "PostToolUse" ? cfg.PostToolUse : []) ?? [];
  const matching = rules.filter((r) => matchesTool(r.matcher, toolName));
  if (matching.length === 0) return { blocked: false, message: "", outcomes: [] };

  const env: Record<string, string> = {
    MANUS_HOOK_EVENT: event,
    MANUS_TOOL_NAME: toolName,
    MANUS_TOOL_ARGS: JSON.stringify(args).slice(0, 8000),
    MANUS_WORKSPACE: workspace,
    MANUS_FILE_PATH: typeof args.path === "string" ? args.path : "",
  };

  const outcomes: HookOutcome[] = [];
  const notes: string[] = [];
  for (const rule of matching) {
    const res = await execHook(rule.command, workspace, env, rule.timeoutMs ?? 20_000);
    outcomes.push(res);
    if (event === "PreToolUse" && res.code !== 0 && rule.blockOnFail !== false) {
      return {
        blocked: true,
        message: `PreToolUse hook blocked "${toolName}" (command: ${rule.command}, exit=${res.code ?? "null"})${res.output ? `\n${res.output}` : ""}`,
        outcomes,
      };
    }
    if (res.code !== 0 || res.output.length > 0) {
      notes.push(`[${event} hook (${rule.command}) exit=${res.code ?? 0}]${res.output ? `\n${res.output}` : ""}`);
    }
  }
  return { blocked: false, message: notes.join("\n"), outcomes };
}
