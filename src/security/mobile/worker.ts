import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { MobileArtifact } from "./artifacts.js";
import type { EvidenceTimeline } from "./evidenceTimeline.js";
import { redactText } from "../red/audit.js";

export interface DeviceExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }
export type DeviceExec = (args: string[], timeoutMs: number) => Promise<DeviceExecResult>;

export interface MobileDeviceEvidence {
  id: string;
  kind: "device-state" | "logcat" | "command";
  summary: string;
  content: string;
  sha256: string;
}

export interface MobileDeviceRunResult {
  platform: "android" | "ios";
  status: "completed" | "partial" | "error" | "unavailable";
  evidence: MobileDeviceEvidence[];
  detail?: string;
}

const defaultExec: DeviceExec = (args, timeoutMs) => new Promise((resolve) => {
  const child = spawn("adb", args, { shell: false, windowsHide: true, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot } });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 1_000_000) stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 20_000) stderr += chunk.toString(); });
  child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, timedOut, error: error.message }); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
});

export interface AndroidWorkerOptions {
  serial: string;
  packageName: string;
  approved: boolean;
  allowDataWipe?: boolean;
  timeline?: { store: EvidenceTimeline; tenantId: string; engagementId: string };
  exec?: DeviceExec;
}

export class AndroidDeviceWorker {
  private readonly exec: DeviceExec;

  constructor(private readonly options: AndroidWorkerOptions) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(options.serial)) throw new Error("invalid Android device serial");
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(options.packageName)) throw new Error("invalid Android package name");
    this.exec = options.exec ?? defaultExec;
  }

  private async command(args: string[]): Promise<DeviceExecResult> {
    if (!this.options.approved) throw new Error("Android device access requires independent approval");
    const result = await this.exec(["-s", this.options.serial, ...args], 30_000);
    if (this.options.timeline) {
      await this.options.timeline.store.append(this.options.timeline.tenantId, this.options.timeline.engagementId, {
        kind: "device",
        summary: `ADB ${args[0] ?? "command"} on authorized package`,
        content: `${result.stdout}\n${result.stderr}`.slice(0, 100_000),
      });
    }
    return result;
  }

  async preflight(): Promise<MobileDeviceRunResult> {
    const evidence: MobileDeviceEvidence[] = [];
    try {
      const state = await this.command(["get-state"]);
      if (state.code !== 0 || state.stdout.trim() !== "device") return { platform: "android", status: "unavailable", evidence, detail: redactText(state.stderr || state.stdout || "device unavailable").slice(0, 300) };
      const pkg = await this.command(["shell", "pm", "path", this.options.packageName]);
      const content = redactText(pkg.stdout).slice(0, 20_000);
      evidence.push({ id: "device-package", kind: "device-state", summary: "Authorized package presence", content, sha256: createHash("sha256").update(content).digest("hex") });
      return { platform: "android", status: pkg.code === 0 ? "completed" : "partial", evidence, ...(pkg.code === 0 ? {} : { detail: "package is not installed on the selected device" }) };
    } catch (error) {
      return { platform: "android", status: "unavailable", evidence, detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    }
  }

  async run(artifact: MobileArtifact): Promise<MobileDeviceRunResult> {
    if (artifact.kind !== "apk") return { platform: "android", status: "error", evidence: [], detail: "Android device worker requires an APK" };
    const evidence: MobileDeviceEvidence[] = [];
    try {
      const install = await this.command(["install", "-r", artifact.path]);
      if (install.code !== 0) return { platform: "android", status: "error", evidence, detail: redactText(install.stderr || install.stdout).slice(0, 300) };
      const start = await this.command(["shell", "monkey", "-p", this.options.packageName, "1"]);
      if (start.code !== 0) return { platform: "android", status: "partial", evidence, detail: "package installed but launch failed" };
      const logs = await this.command(["logcat", "-d", "-v", "time", "-t", "2000"]);
      const content = redactText(logs.stdout).slice(0, 1_000_000);
      evidence.push({ id: "android-logcat", kind: "logcat", summary: "Bounded, redacted logcat capture after authorized launch", content, sha256: createHash("sha256").update(content).digest("hex") });
      return { platform: "android", status: logs.code === 0 ? "completed" : "partial", evidence };
    } catch (error) {
      return { platform: "android", status: "unavailable", evidence, detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    } finally {
      if (this.options.approved) await this.command(["shell", "am", "force-stop", this.options.packageName]).catch(() => undefined);
    }
  }

  async cleanup(): Promise<{ success: boolean; evidenceSha256: string; detail: string }> {
    if (!this.options.approved || this.options.allowDataWipe !== true) throw new Error("device data wipe requires separate explicit approval");
    const stopped = await this.command(["shell", "am", "force-stop", this.options.packageName]);
    const cleared = stopped.code === 0 ? await this.command(["shell", "pm", "clear", this.options.packageName]) : stopped;
    const content = redactText(`${stopped.stdout}\n${cleared.stdout}\n${stopped.stderr}\n${cleared.stderr}`).slice(0, 20_000);
    return {
      success: stopped.code === 0 && cleared.code === 0 && /success/i.test(cleared.stdout),
      evidenceSha256: createHash("sha256").update(content).digest("hex"),
      detail: content.slice(0, 300),
    };
  }
}

export async function runIosDeviceWorker(): Promise<MobileDeviceRunResult> {
  return { platform: "ios", status: "unavailable", evidence: [], detail: "No trusted macOS/iOS device provider is configured" };
}
