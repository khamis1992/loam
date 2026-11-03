// src/appbuilder/verifyLoop.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PreviewScreenshotService, type ShotResult } from "../preview/shot.js";
import { checkDesignDoc } from "./designDoc.js";
import { redactSecrets } from "./redact.js";
import { appProcessEnv } from "./processEnv.js";
import type { AppProject, VerifyReport, VerifyStepId, VerifyStepResult, VerifyTier } from "./types.js";

export const MAX_VERIFY_CALLS_PER_RUN = 3;
export const MAX_FAIL_LINES = 60;
export const OUTPUT_TAIL_CHARS = 4_000;

const STEP_TIMEOUT_MS: Record<VerifyStepId, number> = {
  install: 120_000,
  placeholder: 2_000,
  "design-doc": 2_000,
  check: 60_000,
  lint: 90_000,
  typecheck: 120_000,
  build: 180_000,
  visual: 90_000,
  contract: 300_000,
};

export const TIER_STEPS: Record<VerifyTier, VerifyStepId[]> = {
  fast: ["install", "placeholder", "design-doc", "check", "lint", "build"],
  standard: ["install", "placeholder", "design-doc", "check", "lint", "typecheck", "build", "visual"],
  strict: ["install", "placeholder", "design-doc", "check", "lint", "typecheck", "build", "visual", "contract"],
};

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function shortId(prefix: string): string {
  const bytes = randomBytes(12);
  let out = "";
  for (const b of bytes) out += BASE32[b & 31];
  return `${prefix}_${out}`;
}

export interface VerifyDeps {
  /** Starts or reuses the dev server for the project and returns its base URL. §4.8.2 */
  ensureDevServer(project: AppProject): Promise<string>;
  /** Runs the visual reviewer on the screenshots. §4.6.5 */
  reviewVisual(project: AppProject, shot: ShotResult, signal?: AbortSignal): Promise<{ pass: boolean; problems: string[]; parsed: boolean }>;
  /** Runs Loam's existing verifyApplication() contract (src/agent/appVerification.ts:93). Strict tier only. */
  runContract(project: AppProject, signal?: AbortSignal): Promise<{ pass: boolean; reason: string }>;
  shots?: PreviewScreenshotService;
}

function tailLines(text: string, lines: number): string {
  const all = text.replace(/\r\n/g, "\n").split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n").trim();
}

function runCommand(cwd: string, cmd: string, args: string[], env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; output: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, {
      cwd,
      shell: process.platform === "win32" && cmd.endsWith(".cmd"),
      windowsHide: true,
      env: { ...env, CI: "1", NO_COLOR: "1" },
    });
    let output = "";
    const onData = (b: Buffer) => {
      output += b.toString("utf8");
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () => {
      if (child.pid && process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => { output += `\n[loam] timed out after ${timeoutMs} ms`; kill(); }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (err) => { output += `\n[loam] ${err.message}`; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output, ms: Date.now() - started });
    });
  });
}

function result(id: VerifyStepId, ok: boolean, durationMs: number, outputTail: string, extra: Partial<VerifyStepResult> = {}): VerifyStepResult {
  return { id, command: null, ok, skipped: false, durationMs, exitCode: null, outputTail: redactSecrets(outputTail).slice(-OUTPUT_TAIL_CHARS), ...extra };
}

export class VerifyLoop {
  private callsByRun = new Map<string, number>();

  constructor(private deps: VerifyDeps) {}

  async run(o: { project: AppProject; runId: string; tier?: VerifyTier; signal?: AbortSignal }): Promise<VerifyReport> {
    const attempt = (this.callsByRun.get(o.runId) ?? 0) + 1;
    this.callsByRun.set(o.runId, attempt);
    const id = shortId("vr");
    const tier = o.tier ?? o.project.settings.verifyTier;
    const appDir = path.join(o.project.workspaceDir, o.project.appDir);
    const logDir = path.join(o.project.workspaceDir, ".loam", "verify");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${id}.log`);
    const report: VerifyReport = {
      id, projectId: o.project.id, runId: o.runId, attempt, tier, pass: false, steps: [],
      consoleErrors: 0, screenshots: [], visualVerdict: "skipped", visualNotes: "",
      logPath, error: null, startedAt: new Date().toISOString(), finishedAt: "",
    };

    if (attempt > MAX_VERIFY_CALLS_PER_RUN) {
      report.error = "verify_limit";
      report.finishedAt = new Date().toISOString();
      return report;
    }

    const log: string[] = [];
    for (const step of TIER_STEPS[tier]) {
      if (o.signal?.aborted) { report.error = "aborted"; break; }
      const r = await this.runStep(step, o.project, appDir, log, report, o.signal);
      report.steps.push(r);
      if (!r.ok) break;
    }
    fs.writeFileSync(logPath, redactSecrets(log.join("\n")), "utf8");
    report.pass = report.error === null && report.steps.length === TIER_STEPS[tier].length && report.steps.every((s) => s.ok);
    report.finishedAt = new Date().toISOString();
    return report;
  }

  private async runStep(step: VerifyStepId, project: AppProject, appDir: string, log: string[], report: VerifyReport, signal?: AbortSignal): Promise<VerifyStepResult> {
    const started = Date.now();
    switch (step) {
      case "install": {
        if (fs.existsSync(path.join(appDir, "node_modules", ".bin"))) {
          return result(step, true, 0, "", { skipped: true });
        }
        const r = await runCommand(appDir, "node", ["scripts/link-deps.mjs"], appProcessEnv(project), STEP_TIMEOUT_MS.install, signal);
        log.push(`===== node scripts/link-deps.mjs (exit ${r.code}, ${r.ms} ms) =====`, r.output);
        return result(step, r.code === 0, r.ms, r.code === 0 ? "" : tailLines(r.output, MAX_FAIL_LINES), { command: "node scripts/link-deps.mjs", exitCode: r.code });
      }
      case "placeholder": {
        const index = path.join(appDir, "src", "pages", "Index.tsx");
        const text = fs.existsSync(index) ? fs.readFileSync(index, "utf8") : "";
        const ok = text.length > 0 && !text.includes("LOAM_PLACEHOLDER_PAGE");
        return result(step, ok, Date.now() - started, ok ? "" : "src/pages/Index.tsx is still the template placeholder. Replace it with the real home page.");
      }
      case "design-doc": {
        const file = path.join(project.workspaceDir, "DESIGN.md"); // workspace root, §4.4.1
        const d = fs.existsSync(file) ? checkDesignDoc(fs.readFileSync(file, "utf8")) : { ok: false, problems: ["file is missing; write it before any page code"] };
        return result(step, d.ok, Date.now() - started, d.ok ? "" : `DESIGN.md: ${d.problems.join("; ")}`);
      }
      case "check":
      case "lint":
      case "typecheck":
      case "build": {
        const r = await runCommand(appDir, NPM, ["run", step, "--silent"], appProcessEnv(project), STEP_TIMEOUT_MS[step], signal);
        log.push(`===== npm run ${step} (exit ${r.code}, ${r.ms} ms) =====`, r.output);
        const tail = r.code === 0 ? "" : tailLines(r.output, MAX_FAIL_LINES) || `npm run ${step} failed with exit code ${r.code}.`;
        return result(step, r.code === 0, r.ms, tail, { command: `npm run ${step}`, exitCode: r.code });
      }
      case "visual":
        return this.visualStep(project, report, signal);
      case "contract": {
        const c = await this.deps.runContract(project, signal);
        return result(step, c.pass, Date.now() - started, c.pass ? "" : `Contract failed: ${c.reason}`);
      }
    }
  }

  private async visualStep(project: AppProject, report: VerifyReport, signal?: AbortSignal): Promise<VerifyStepResult> {
    const started = Date.now();
    const shots = this.deps.shots ?? new (PreviewScreenshotService as unknown as new (opts: unknown) => InstanceType<typeof PreviewScreenshotService>)(undefined);
    const url = await this.deps.ensureDevServer(project);
    const shot = await shots.capture({
      workspace: project.workspaceDir,
      url,
      outDir: path.join(project.workspaceDir, ".loam", "shots", report.id),
      viewports: [
        { name: "mobile", width: 375, height: 812 },
        { name: "desktop", width: 1440, height: 900 },
      ],
      waitMs: 1_200,
      fullPage: true,
      signal,
    });
    report.screenshots = shot.shots.map((s) => s.relative);
    report.consoleErrors = shot.errors.length;
    if (shot.unavailable) {
      report.visualVerdict = "unavailable";
      report.visualNotes = shot.message ?? "browser unavailable";
      return result("visual", true, Date.now() - started, `Visual review skipped: ${report.visualNotes}.`, { skipped: true });
    }
    if (shot.errors.length > 0) {
      report.visualVerdict = "fail";
      report.visualNotes = shot.errors.slice(0, 10).join("\n");
      return result("visual", false, Date.now() - started, `The page logged errors:\n${report.visualNotes}`);
    }
    const review = await this.deps.reviewVisual(project, shot, signal);
    report.visualVerdict = review.pass ? "pass" : "fail";
    report.visualNotes = review.parsed ? review.problems.join("\n") : "reviewer reply did not parse; counted as pass";
    return result("visual", review.pass, Date.now() - started, review.pass ? "" : `Visual review found:\n- ${review.problems.slice(0, 8).join("\n- ")}`);
  }

  /** Called when a run ends so the per-run counter does not grow forever. */
  endRun(runId: string): void {
    this.callsByRun.delete(runId);
  }
}

/** The text the model sees. Kept short on purpose. */
export function formatVerifyReportForModel(r: VerifyReport): string {
  if (r.error === "verify_limit") return "verify_limit: app_verify already ran 3 times in this run. Stop and report what still fails.";
  const lines = [`app_verify ${r.pass ? "PASSED" : "FAILED"} (tier ${r.tier}, attempt ${r.attempt} of ${MAX_VERIFY_CALLS_PER_RUN})`];
  for (const s of r.steps) {
    lines.push(`${s.ok ? "ok  " : "FAIL"} ${s.id}${s.skipped ? " (skipped)" : ""}`);
    if (!s.ok) lines.push(s.outputTail);
  }
  if (!r.pass && r.error === null) lines.push("Fix only what failed, then call app_verify again.");
  return lines.join("\n");
}
