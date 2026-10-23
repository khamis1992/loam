import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isInside, resolveRead } from "../policy/paths.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str, strs } from "./registry.js";

// ---------------------------------------------------------------------------
// `think` and `finish`.
//
// `think` is a private scratchpad: it never becomes an assistant message. No
// `thinking`-style event exists in src/agent/events.ts, so it emits nothing.
//
// `finish` closes a task. Before emitting `done` it enforces a verification
// gate: when the trusted project file `<workspace>/.loam/verify.json` exists,
// every configured command is run through the platform shell and must succeed.
// ---------------------------------------------------------------------------

const VERIFY_FILE = path.join(".loam", "verify.json");
const DEFAULT_GATE_TIMEOUT_SEC = 600;
const MAX_GATE_TIMEOUT_SEC = 3600;
const TAIL_LINES = 40;
const NOTE_MAX = 8000;

const CONFIDENCE = ["high", "medium", "low"] as const;
type Confidence = (typeof CONFIDENCE)[number];

export interface GateResult {
  code: number;
  output: string;
}

/** Runs one verification gate command. Injectable so tests never spawn shells. */
export type GateRunner = (cmd: string, opts: { cwd: string; timeoutMs: number }) => Promise<GateResult>;

export interface FinishToolsOptions {
  /** Override the command runner (tests). Defaults to child_process.exec. */
  runGate?: GateRunner;
}

/** Default runner: the platform shell, exactly as written in the trusted file. */
export function defaultGateRunner(cmd: string, opts: { cwd: string; timeoutMs: number }): Promise<GateResult> {
  return new Promise((resolve) => {
    exec(
      cmd,
      { cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        const output = `${stdout ?? ""}${stderr ?? ""}`.replace(/\s+$/, "");
        resolve({ code, output });
      },
    );
  });
}

function tail(output: string, lines = TAIL_LINES): string {
  const all = output.split(/\r?\n/);
  return all.length <= lines ? output : all.slice(-lines).join("\n");
}

/** Resolve a proof path inside the workspace; null when it escapes. */
function proofInside(workspace: string, input: string): string | null {
  try {
    const abs = resolveRead(workspace, input, false);
    return isInside(workspace, abs) ? abs : null;
  } catch {
    return null;
  }
}

function resolveGateCwd(workspace: string, input: unknown): string {
  const raw = typeof input === "string" && input.trim().length > 0 ? input : ".";
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw);
  if (!isInside(workspace, abs)) throw new Error(`gate cwd escapes workspace: ${raw}`);
  return abs;
}

interface VerifyCommand {
  name: string;
  cmd: string;
  cwd: string;
}

interface VerifyConfig {
  commands: VerifyCommand[];
  timeoutSec: number;
}

function readVerifyConfig(workspace: string): VerifyConfig | null {
  const file = path.join(workspace, VERIFY_FILE);
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`invalid ${VERIFY_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid ${VERIFY_FILE}: expected an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const rawCommands = obj.commands;
  if (!Array.isArray(rawCommands)) throw new Error(`invalid ${VERIFY_FILE}: "commands" must be an array`);
  const commands: VerifyCommand[] = [];
  for (const [i, raw] of rawCommands.entries()) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`invalid ${VERIFY_FILE}: commands[${i}] must be an object`);
    }
    const cmd = (raw as Record<string, unknown>).cmd;
    if (typeof cmd !== "string" || cmd.trim().length === 0) {
      throw new Error(`invalid ${VERIFY_FILE}: commands[${i}].cmd must be a non-empty string`);
    }
    const nameRaw = (raw as Record<string, unknown>).name;
    commands.push({
      name: typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : `gate_${i + 1}`,
      cmd: cmd.trim(),
      cwd: resolveGateCwd(workspace, (raw as Record<string, unknown>).cwd),
    });
  }
  const timeoutRaw = obj.timeoutSec;
  const timeoutSec = typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw)
    ? Math.max(1, Math.min(MAX_GATE_TIMEOUT_SEC, timeoutRaw))
    : DEFAULT_GATE_TIMEOUT_SEC;
  return { commands, timeoutSec };
}

function report(summary: string, confidence: Confidence, proof: string[], followups: string[], gates: VerifyCommand[]): string {
  return JSON.stringify(
    {
      summary,
      confidence,
      proof,
      followups,
      gatesPassed: gates.length,
      gates: gates.map((g) => ({ name: g.name, cmd: g.cmd, ok: true })),
    },
    null,
    2,
  );
}

function thinkTool(): Tool {
  return {
    name: "think",
    description:
      "Private scratchpad for reasoning or notes. It records the note without emitting an assistant message or any visible side effect, and returns 'noted'. Use it to work through a problem step by step or to park a reminder for a later step without polluting the conversation; the note never reaches the user. When NOT to use: use file_write to persist notes to disk, the plan tool to track progress visibly, and finish to close the task; never use it as a substitute for taking action.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["note"],
      properties: {
        note: { type: "string", minLength: 1, maxLength: NOTE_MAX, description: "Private note (1..8000 chars)." },
      },
    },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const note = str(args, "note");
      if (note.trim().length === 0) return { ok: false, content: "think requires a non-empty note" };
      if (note.length > NOTE_MAX) return { ok: false, content: `think note must be at most ${NOTE_MAX} characters` };
      // No `thinking` event exists in src/agent/events.ts, so nothing is emitted
      // and the note never reaches the user as an assistant message.
      return { ok: true, content: "noted" };
    },
  };
}

function finishTool(options: FinishToolsOptions): Tool {
  const runGate = options.runGate ?? defaultGateRunner;
  return {
    name: "finish",
    description:
      "Finish the task and report the result. Before the done event is emitted, the tool validates that every proof path resolves inside the workspace and exists, and runs the project's .loam/verify.json gate commands when that trusted file is present — every gate must pass or the finish is rejected. Provide a concise summary, a confidence level (high, medium or low), optional workspace-relative proof paths and optional follow-ups. When NOT to use: call it only when the work is genuinely complete and verified; use the plan tool to present a plan for approval, and keep working with file_*/shell_* instead of finishing early; never cite proof paths that do not exist.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "confidence"],
      properties: {
        summary: { type: "string", minLength: 1, description: "What was accomplished." },
        proof: { type: "array", items: { type: "string" }, description: "Workspace-relative paths proving the work." },
        confidence: { type: "string", enum: [...CONFIDENCE], description: "How confident you are in the result." },
        followups: { type: "array", items: { type: "string" }, description: "Optional suggested next steps." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const summary = str(args, "summary");
      if (summary.trim().length === 0) return { ok: false, content: "finish requires a non-empty summary" };

      const confidence = str(args, "confidence") as Confidence;
      if (!CONFIDENCE.includes(confidence)) {
        return { ok: false, content: `finish confidence must be one of: ${CONFIDENCE.join(", ")}` };
      }

      const proofInputs = strs(args, "proof");
      const proof: string[] = [];
      const missing: string[] = [];
      for (const input of proofInputs) {
        const abs = proofInside(ctx.workspace, input);
        if (!abs) {
          missing.push(`${input} (escapes workspace)`);
        } else if (!fs.existsSync(abs)) {
          missing.push(`${input} (not found)`);
        } else {
          proof.push(input);
        }
      }
      if (missing.length > 0) {
        return { ok: false, content: `finish proof path(s) invalid: ${missing.join("; ")}` };
      }

      let config: VerifyConfig;
      try {
        config = readVerifyConfig(ctx.workspace) ?? { commands: [], timeoutSec: DEFAULT_GATE_TIMEOUT_SEC };
      } catch (err) {
        return { ok: false, content: err instanceof Error ? err.message : String(err) };
      }

      for (const gate of config.commands) {
        let result: GateResult;
        try {
          result = await runGate(gate.cmd, { cwd: gate.cwd, timeoutMs: config.timeoutSec * 1000 });
        } catch (err) {
          return {
            ok: false,
            content: `verification gate "${gate.name}" could not run (${gate.cmd}): ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (result.code !== 0) {
          return {
            ok: false,
            content: `verification gate "${gate.name}" failed (exit ${result.code}): ${gate.cmd}\n${tail(result.output)}`,
          };
        }
      }

      const followups = strs(args, "followups");
      ctx.emit({ type: "done", text: summary, steps: 0, model: ctx.cfg.model });
      return { ok: true, content: report(summary, confidence, proof, followups, config.commands) };
    },
  };
}

/** Build the `think` and `finish` tools. */
export function createFinishTools(options: FinishToolsOptions = {}): Tool[] {
  return [thinkTool(), finishTool(options)];
}
