/**
 * Test helpers for C11. A scripted executor stands in for runAgent: it calls the worker's
 * real per-turn registry (board tools + confined Loam tools), so admission, delivery,
 * branch switching and engine merges run for real against git on a temp directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunOptions, RunResult } from "../../agent/loop.js";
import { ToolRegistry, type Tool, type ToolResult } from "../../tools/registry.js";
import type { SwarmHost } from "../swarm/loamHost.js";
import type { SwarmExecutor } from "../swarm/worker.js";
import type { SwarmCorePort, SwarmSpan } from "../swarm/types.js";
import type { SwarmCoreFactory } from "../swarm/corePort.js";
import type { WorkerCheckpoint } from "../../agent/checkpoint.js";
import { testConfig } from "./helpers.js";
import type { Config } from "../../config.js";
import { coordinationDbPath, CoordinationDb } from "../swarm/board.js";

const exec = promisify(execFile);

// Every test process gets its own manus.db (the Core's tables), never the dev data dir.
process.env.LOAM_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "loam-c11-data-"));
process.env.MANUS_LOCAL_DATA_DIR ??= process.env.LOAM_DATA_DIR;
// The remote provider in testConfig() is keyed by X_KEY; without the key the router
// treats its model as unusable and the cloud-only checks cannot see it.
process.env.X_KEY ??= "test-key";

export function tmpDir(prefix = "c11-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

export async function sh(cwd: string, cmd: string): Promise<string> {
  const [shell, args] = process.platform === "win32" ? ["cmd", ["/d", "/s", "/c", cmd]] : ["sh", ["-c", cmd]];
  const { stdout } = await exec(shell, args, { cwd, windowsHide: true, env: GIT_ENV });
  return stdout.trim();
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, windowsHide: true, env: GIT_ENV });
  return stdout.trim();
}

async function gitCommit(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Cloud-capable config: "remote-model" is an https provider in testConfig(). */
export function swarmConfig(): Config {
  const cfg = testConfig();
  cfg.model = "remote-model";
  return cfg;
}

/** Minimal Loam tools the fake workers use; real tools come from Loam's registry. */
export function baseTools(): ToolRegistry {
  const r = new ToolRegistry();
  const t = (name: string, run: Tool["run"]): Tool => ({ name, description: name, parameters: { type: "object" }, run });
  r.registerAll([
    t("file_write", async (a, ctx) => {
      const p = path.join(ctx.workspace, String(a.path));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(a.content ?? ""));
      return { ok: true, content: `wrote ${a.path}` };
    }),
    t("file_read", async (a, ctx) => ({ ok: true, content: fs.readFileSync(path.join(ctx.workspace, String(a.path)), "utf8") })),
    t("git_commit", async (a, ctx) => ({ ok: true, content: await gitCommit(ctx.workspace, String(a.message ?? "change")) })),
    t("shell_run", async (a, ctx) => {
      try {
        return { ok: true, content: await sh(ctx.workspace, String(a.command)) };
      } catch (err) {
        return { ok: false, content: err instanceof Error ? err.message : String(err) };
      }
    }),
    // Not in WORKER_TOOL_NAMES: must never reach a worker.
    t("mirofish_run", async () => ({ ok: true, content: "should not be callable" })),
  ]);
  return r;
}

export interface TurnCtx {
  worker: string;
  turn: number;
  opts: RunOptions;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
}

/** Wraps a per-turn script into a SwarmExecutor; steps = number of tool calls + 1. */
export function scriptedExecutor(script: (c: TurnCtx) => Promise<string | void>): SwarmExecutor & { runs: RunOptions[]; steps: number[] } {
  const runs: RunOptions[] = [];
  const steps: number[] = [];
  const fn = (async (opts: RunOptions): Promise<RunResult> => {
    runs.push(opts);
    const m = /^realswarm-realswarm_[a-f0-9-]{36}-(w\d+)-(\d+)$/.exec(opts.sessionId ?? "");
    if (!m) throw new Error(`unexpected sessionId ${opts.sessionId}`);
    let calls = 0;
    const ctx: TurnCtx = {
      worker: m[1]!,
      turn: Number(m[2]),
      opts,
      call: (name, args = {}) => {
        calls++;
        return opts.tools.exec(name, args, { cfg: opts.cfg, workspace: opts.cfg.workspace ?? "", emit: () => undefined, signal: opts.signal });
      },
    };
    const text = (await script(ctx)) ?? "";
    steps.push(calls + 1);
    return { text, messages: [], steps: calls + 1, model: opts.model ?? opts.cfg.model, usage: { promptTokens: 10, completionTokens: 5, durationMs: 1 } };
  }) as SwarmExecutor & { runs: RunOptions[]; steps: number[] };
  fn.runs = runs;
  fn.steps = steps;
  return fn;
}

/** A worker that claims `label`, writes `file`, commits, merges, then posts a verified patch. */
export async function doSubtask(c: TurnCtx, label: string, file: string, content: string): Promise<{ merge: ToolResult }> {
  await c.call("board_read");
  const claim = await c.call("board_write", { type: "CLAIM", content: `implement ${label}`, work_label: label });
  if (!claim.ok) throw new Error(claim.content);
  await c.call("file_write", { path: file, content });
  await c.call("git_commit", { message: `${c.worker}: ${label}` });
  const merge = await c.call("merge_request", { work_label: label });
  if (merge.content.startsWith("merged")) {
    const ps = await c.call("board_write", { type: "PATCH_SUMMARY", content: `files=${file} | idea=${label} | evidence=cat ${file} passed`, work_label: label });
    if (!ps.ok) throw new Error(ps.content);
  }
  return { merge };
}

export function testHost(root: string): SwarmHost & { statuses: Array<[string, string]> } {
  let n = 0;
  const statuses: Array<[string, string]> = [];
  return {
    statuses,
    createRunWorkspace() {
      const taskId = `task-${++n}`;
      const workspace = path.join(root, "tasks", taskId);
      fs.mkdirSync(workspace, { recursive: true });
      return { taskId, workspace };
    },
    setTaskStatus(taskId, status) {
      statuses.push([taskId, status]);
    },
  };
}

/** In-memory test double for the Core port: records spans, checkpoints and judgements. */
export function recordingPort(over: Partial<SwarmCorePort> = {}): SwarmCorePort & {
  spans: Array<{ name: string; attrs: Record<string, unknown>; ended: boolean; error?: string; parent?: string }>;
  saved: Map<string, { cp: WorkerCheckpoint; rev: number }>;
} {
  const spans: Array<{ name: string; attrs: Record<string, unknown>; ended: boolean; error?: string; parent?: string }> = [];
  const saved = new Map<string, { cp: WorkerCheckpoint; rev: number }>();
  const port = {
    spans,
    saved,
    tracing: {
      startSpan(name: string, attrs: Record<string, string | number | boolean>, parent?: SwarmSpan): SwarmSpan {
        const rec: { name: string; attrs: Record<string, unknown>; ended: boolean; error?: string; parent?: string } = { name, attrs: { ...attrs }, ended: false, ...(parent ? { parent: (parent as SwarmSpan & { name?: string }).name ?? "?" } : {}) };
        spans.push(rec);
        const span = {
          traceId: "trace-test",
          name,
          end(a?: Record<string, string | number | boolean>, error?: string) {
            rec.ended = true;
            if (a) Object.assign(rec.attrs, a);
            if (error) rec.error = error;
          },
        };
        return span;
      },
    },
    checkpoints: {
      saveWorker(key: string, cp: WorkerCheckpoint, rev: number) {
        saved.set(key, { cp, rev });
      },
      loadLatestWorker(key: string) {
        return saved.get(key)?.cp;
      },
    },
    ...over,
  };
  return port as typeof port & SwarmCorePort;
}

export const factoryFor = (port: SwarmCorePort): SwarmCoreFactory => () => ({ port, end: () => undefined });

/** Opens the run's coordination DB for assertions. */
export function openDb(runRoot: string): CoordinationDb {
  return new CoordinationDb(coordinationDbPath(runRoot));
}
