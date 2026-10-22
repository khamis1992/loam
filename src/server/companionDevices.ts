/**
 * Companion device layer (طبقة أجهزة المساعدين المستقلة) — frontier stage 2.
 *
 * A companion device is a real isolated execution environment registered under a
 * distro/VM name owned by one agent. On this host the primary provider is WSL2
 * (real separate processes, filesystem and Linux user; the ext4 vhdx under
 * devices/<id>/ IS the persistent storage). Snapshots are `wsl --export` tars and
 * restore is unregister + import — a genuine restore point, not a copy of files.
 *
 * All OS interaction goes through a DeviceRunner so the deterministic gate can
 * inject a fake runner (LOAM_DEVICE_RUNNER=fake) exactly like the swarm engine's
 * injected executor. Nothing here simulates a device when the real runner is
 * active: missing providers surface as explicit unavailable state.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { DATA_DIR } from "../config.js";
import { log } from "../log.js";

export type DeviceEnvironment = "linux" | "windows";
export type DeviceProviderKind = "wsl" | "hyperv" | "fake";
export type DeviceState = "provisioning" | "running" | "stopped" | "suspended" | "error" | "deleted";

export interface DeviceResources {
  cpus: number;
  memoryMB: number;
  diskGB: number;
}

export interface DeviceSnapshot {
  id: string;
  label: string;
  at: string;
  file: string;
  bytes: number;
}

export interface CompanionDeviceRecord {
  id: string;
  agentId: string;
  name: string;
  environment: DeviceEnvironment;
  provider: DeviceProviderKind;
  template: string;
  resources: DeviceResources;
  state: DeviceState;
  /** Registered OS-level name (wsl distro name / hyper-v vm name). */
  osName: string;
  /** Persistent on-disk location of the device (vhdx dir + snapshots + journal). */
  storagePath: string;
  lastError?: string;
  /** While "user", the companion's device_* tools are refused (take-control interlock). */
  controlHeldBy: "agent" | "user";
  snapshots: DeviceSnapshot[];
  createdAt: string;
  updatedAt: string;
}

export interface DeviceProviders {
  wsl: boolean;
  hyperv: boolean;
  fake: boolean;
  /** Populated when detection ran with the real runner. */
  wslDistros?: string[];
}

export interface DeviceJournalEntry {
  at: string;
  kind: "agent" | "user" | "system";
  event: string;
  ok: boolean;
  detail?: string;
}

export interface RunnerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DeviceRunner {
  kind: DeviceProviderKind;
  detect(): Promise<DeviceProviders>;
  /** Register a new environment from a rootfs tarball. */
  importDevice(osName: string, installDir: string, tarFile: string): Promise<RunnerResult>;
  unregister(osName: string): Promise<RunnerResult>;
  terminate(osName: string): Promise<RunnerResult>;
  exportDevice(osName: string, tarFile: string): Promise<RunnerResult>;
  /** Run a command inside the device as a user; bash -lc semantics. Aborting the
   *  signal must actually kill the spawned process — takeover relies on it. */
  exec(osName: string, user: string, command: string, timeoutMs?: number, signal?: AbortSignal): Promise<RunnerResult>;
  /** Permanently delete the device environment; unregister only detaches (restore needs the data). */
  destroy?(osName: string): Promise<RunnerResult>;
}

/* ------------------------------------------------------------------ */
/* Real Windows runner (wsl.exe + powershell detection)                */
/* ------------------------------------------------------------------ */

const wslExe = (args: string[], timeoutMs: number, signal?: AbortSignal): Promise<RunnerResult> =>
  new Promise((resolve) => {
    const child = execFile("wsl.exe", args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }, (err, stdout, stderr) => {
      // wsl.exe prints UTF-16LE on stdout; detect via BOM or interleaved NULs.
      const decode = (buf: Buffer): string => {
        if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || buf.includes(0) && buf.length % 2 === 0 && buf.subarray(0, 2).every((b) => b < 0x80))) {
          return buf.toString("utf16le");
        }
        return buf.toString("utf8");
      };
      resolve({
        code: err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number" ? Number((err as NodeJS.ErrnoException & { code: number }).code) : err ? 1 : 0,
        stdout: decode(stdout ?? Buffer.alloc(0)).replace(/\0/g, "").trim(),
        stderr: decode(stderr ?? Buffer.alloc(0)).replace(/\0/g, "").trim(),
      });
    });
    if (signal) {
      const onAbort = (): void => { child.kill(); };
      if (signal.aborted) child.kill(); else signal.addEventListener("abort", onAbort, { once: true });
    }
  });

const runPowerShell = (command: string, timeoutMs = 20_000): Promise<RunnerResult> =>
  new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", command], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout ?? "").trim(), stderr: String(stderr ?? "").trim() });
    });
  });

export class RealDeviceRunner implements DeviceRunner {
  readonly kind = "wsl" as const;

  async detect(): Promise<DeviceProviders> {
    const status = await wslExe(["--status"], 15_000);
    const hyperv = await runPowerShell("if (Get-Command Get-VM -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }");
    let wslDistros: string[] | undefined;
    if (status.code === 0) {
      const list = await wslExe(["--list", "--quiet"], 15_000);
      if (list.code === 0) {
        wslDistros = list.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      }
    }
    return { wsl: status.code === 0, hyperv: hyperv.code === 0 && hyperv.stdout.includes("yes"), fake: false, ...(wslDistros ? { wslDistros } : {}) };
  }

  importDevice(osName: string, installDir: string, tarFile: string): Promise<RunnerResult> {
    return wslExe(["--import", osName, installDir, tarFile, "--version", "2"], 15 * 60_000);
  }
  unregister(osName: string): Promise<RunnerResult> {
    return wslExe(["--unregister", osName], 120_000);
  }
  terminate(osName: string): Promise<RunnerResult> {
    return wslExe(["--terminate", osName], 60_000);
  }
  exportDevice(osName: string, tarFile: string): Promise<RunnerResult> {
    return wslExe(["--export", osName, tarFile], 15 * 60_000);
  }
  exec(osName: string, user: string, command: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<RunnerResult> {
    return wslExe(["-d", osName, "-u", user, "--", "bash", "-lc", command], timeoutMs, signal);
  }
}

/* ------------------------------------------------------------------ */
/* Fake runner — deterministic gate only (LOAM_DEVICE_RUNNER=fake)     */
/* Implements the exact command protocol emitted by the tools/manager  */
/* plus an in-memory device filesystem, so read/write/list round-trip. */
/* ------------------------------------------------------------------ */

/** Deterministic 8x8 blue PNG used as the fake device screen frame. */
const FAKE_SCREEN_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4EIwESMolGFI0chAG+bAR115Dd9AAAAAElFTkSuQmCC";

class FakeDeviceRunner implements DeviceRunner {
  readonly kind = "fake" as const;
  /** osName -> Map<path, base64 content> */
  readonly filesystems = new Map<string, Map<string, string>>();
  readonly calls: Array<{ op: string; osName: string; detail?: string }> = [];
  /** GUI session state for the viewer protocol. */
  readonly guiBooted = new Set<string>();
  readonly guiReady_ = new Set<string>();
  readonly guiInputs: string[] = [];

  private fs(osName: string): Map<string, string> {
    if (!this.filesystems.has(osName)) this.filesystems.set(osName, new Map());
    return this.filesystems.get(osName)!;
  }

  async detect(): Promise<DeviceProviders> {
    this.calls.push({ op: "detect", osName: "" });
    return { wsl: true, hyperv: false, fake: true, wslDistros: ["Ubuntu-24.04-fake"] };
  }

  async importDevice(osName: string, installDir: string, tarFile: string): Promise<RunnerResult> {
    this.calls.push({ op: "import", osName, detail: `${installDir} <- ${tarFile}` });
    this.fs(osName);
    return { code: 0, stdout: "imported", stderr: "" };
  }
  async unregister(osName: string): Promise<RunnerResult> {
    this.calls.push({ op: "unregister", osName });
    this.filesystems.delete(osName);
    return { code: 0, stdout: "unregistered", stderr: "" };
  }
  async terminate(osName: string): Promise<RunnerResult> {
    this.calls.push({ op: "terminate", osName });
    return { code: 0, stdout: "", stderr: "" };
  }
  async exportDevice(osName: string, tarFile: string): Promise<RunnerResult> {
    this.calls.push({ op: "export", osName, detail: tarFile });
    fs.mkdirSync(path.dirname(tarFile), { recursive: true });
    fs.writeFileSync(tarFile, Buffer.concat([Buffer.from(`FAKE-TAR:${osName}`), Buffer.alloc(500, 0x41)]));
    return { code: 0, stdout: "", stderr: "" };
  }

  async exec(osName: string, user: string, command: string, timeoutMs?: number, signal?: AbortSignal): Promise<RunnerResult> {
    this.calls.push({ op: "exec", osName, detail: `${user}: ${command}` });
    // Cancellable sleep protocol: lets the live-takeover test observe a real abort.
    const sleepMatch = /^sleep (\d+(?:\.\d+)?)$/.exec(command.trim());
    if (sleepMatch) {
      const ms = Math.min(Number(sleepMatch[1]) * 1000, timeoutMs ?? 120_000);
      const aborted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout((): void => resolve(false), ms);
        if (!signal) return;
        const onAbort = (): void => { clearTimeout(timer); resolve(true); };
        if (signal.aborted) { clearTimeout(timer); resolve(true); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return aborted ? { code: 143, stdout: "", stderr: "terminated by takeover" } : { code: 0, stdout: "", stderr: "" };
    }
    const files = this.fs(osName);
    const norm = (p: string): string => p.replace(/^"|"$/g, "");
    // Write protocol: ... && printf %s <b64> | base64 -d > path && ...
    let m = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d > ("(?:[^"]|\\")*")/.exec(command);
    if (m?.[1] && m[2]) {
      files.set(norm(m[2]), m[1]);
      return { code: 0, stdout: String(Buffer.from(m[1], "base64").length), stderr: "" };
    }
    // Read protocol: base64 -w0 "path"
    m = /base64 -w0 ("(?:[^"]|\\")*")/.exec(command);
    if (m?.[1]) {
      const key = norm(m[1]);
      const content = files.get(key);
      if (content === undefined) return { code: 1, stdout: "", stderr: `cat: ${m[1]}: No such file or directory` };
      return { code: 0, stdout: content, stderr: "" };
    }
    // List protocol
    m = /ls -la --time-style=\+long-iso ("(?:[^"]|\\")*")/.exec(command);
    if (m?.[1]) {
      const dir = norm(m[1]);
      const rows = [...files.keys()].filter((p) => path.posix.dirname(p) === dir || dir === "/").map((p) => `-rw-r--r-- 1 loam loam 1024 2026-10-18 10:00 ${path.posix.basename(p)}`);
      return { code: 0, stdout: rows.join("\n") || "total 0", stderr: "" };
    }
    if (command === "echo loam-ready") return { code: 0, stdout: "loam-ready", stderr: "" };
    // GUI viewer protocol: session boot, frame capture (x11grab → real PNG bytes), window list, manual input.
    if (command.startsWith("if [ -f /tmp/.loam-gui-ready ]")) {
      this.guiReady_.add(osName);
      return { code: 0, stdout: this.guiBooted.has(osName) ? "ready" : (this.guiBooted.add(osName), "started"), stderr: "" };
    }
    if (command.startsWith("test -f /tmp/.loam-gui-ready")) {
      return { code: this.guiReady_.has(osName) ? 0 : 1, stdout: this.guiReady_.has(osName) ? "gui-up" : "", stderr: "" };
    }
    if (command.includes("x11grab")) {
      if (!this.guiReady_.has(osName)) return { code: 1, stdout: "", stderr: "Xvfb not running" };
      return { code: 0, stdout: FAKE_SCREEN_PNG_BASE64, stderr: "" };
    }
    if (command.includes("wmctrl -l")) {
      if (!this.guiReady_.has(osName)) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "0x04a00003 -1 loam-device fluxbox\n0x04a00006 0 loam-device xterm — Loam Companion Device", stderr: "" };
    }
    if (command.includes("xdotool")) {
      if (!this.guiReady_.has(osName)) return { code: 1, stdout: "", stderr: "no X session" };
      this.guiInputs.push(command.replace(/^DISPLAY=:99 xdotool /, "").slice(0, 120));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command.startsWith("grep -c .")) return { code: 0, stdout: "0", stderr: "" };
    if (command.includes("/proc/meminfo")) return { code: 0, stdout: "MemTotal:       8000000 kB\nMemFree:        4000000 kB\n---\n/dev/sdc 100G 12G 88G 12% /", stderr: "" };
    if (command.includes("Filesystem") || command.startsWith("df ")) return { code: 0, stdout: "Filesystem Size Used Avail Use%\n/dev/sdc 100G 12G 88G 12%", stderr: "" };
    return { code: 0, stdout: `fake-ok: ${command.slice(0, 80)}`, stderr: "" };
  }
}

/** Shared instance when LOAM_DEVICE_RUNNER=fake (deterministic gate / offline dev). */
export const fakeRunner = new FakeDeviceRunner();

/* ------------------------------------------------------------------ */
/* SSH provider (frontier 4): a companion device on ANOTHER machine —
   a server or a second box — driven over ssh. The device is a dedicated
   directory + user on the remote host: its processes and filesystem live
   THERE, never on the user's machine.                                 */

export interface SshTarget {
  host: string;
  port?: number;
  user?: string;
  /** Absolute base directory on the remote host for device folders. */
  baseDir: string;
  keyFile?: string;
}

/** Tar streaming over ssh: optional stdin, binary stdout (used by import/export). */
const sshArgs = (target: SshTarget, remoteCommand: string): string[] => [
  "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
  ...(target.port ? ["-p", String(target.port)] : []),
  ...(target.keyFile ? ["-i", target.keyFile] : []),
  target.user ? `${target.user}@${target.host}` : target.host,
  remoteCommand,
];

const runSshStream = async (target: SshTarget, remoteCommand: string, input?: Buffer): Promise<Buffer> => {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("ssh", sshArgs(target, remoteCommand), { timeout: 15 * 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...(input ? { input } : {}) }) as Buffer;
};

const runSsh = async (target: SshTarget, remoteCommand: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const args = [
      "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10",
      ...(target.port ? ["-p", String(target.port)] : []),
      ...(target.keyFile ? ["-i", target.keyFile] : []),
      target.user ? `${target.user}@${target.host}` : target.host,
      remoteCommand,
    ];
    const child = execFile("ssh", args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    if (signal) {
      const onAbort = (): void => { child.kill(); };
      if (signal.aborted) child.kill(); else signal.addEventListener("abort", onAbort, { once: true });
    }
  });

export class SshDeviceRunner implements DeviceRunner {
  readonly kind = "wsl" as const; // satisfies the provider union; remote semantics documented below
  constructor(
    private readonly target: SshTarget,
    private readonly ssh: (target: SshTarget, cmd: string, timeoutMs?: number, signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string }> = runSsh,
    /** Stream stdin/stdout over ssh (tar in/out). Injectable for deterministic tests. */
    private readonly stream: (target: SshTarget, remoteCommand: string, input?: Buffer) => Promise<Buffer> = runSshStream,
  ) {}

  /** Remote devices live on their own machine; the user's WSL state is irrelevant. */
  async detect(): Promise<DeviceProviders> {
    const res = await this.ssh(this.target, "echo ok");
    return { wsl: res.code === 0 && res.stdout.includes("ok"), hyperv: false, fake: false, wslDistros: [] };
  }

  private remoteDir(osName: string): string {
    const base = this.target.baseDir.replace(/\/+$/, "");
    return `${base}/${osName}`;
  }

  async importDevice(osName: string, installDir: string, tarFile: string): Promise<RunnerResult> {
    // Restore unpacks the snapshot archive over a freshly emptied directory. The archive is
    // verified BEFORE anything is cleared, and the directory is replaced whole (rm -rf && mkdir -p)
    // so hidden files are removed too — the ssh exit status itself decides success, no echo masking.
    const dir = JSON.stringify(this.remoteDir(osName));
    void installDir;
    if (!tarFile) {
      // No archive requested at all: an empty directory is the device.
      const empty = await this.ssh(this.target, `rm -rf ${dir} && mkdir -p ${dir}`);
      if (empty.code !== 0) return empty;
      return { code: 0, stdout: "imported (no archive)", stderr: "" };
    }
    // A named archive that is missing or empty is a broken restore: fail BEFORE clearing.
    if (!fs.existsSync(tarFile)) return { code: 1, stdout: "", stderr: `ملف الأرشيف مفقود: ${tarFile}` };
    if (fs.statSync(tarFile).size === 0) return { code: 1, stdout: "", stderr: `ملف الأرشيف فارغ: ${tarFile}` };
    const cleared = await this.ssh(this.target, `rm -rf ${dir} && mkdir -p ${dir}`);
    if (cleared.code !== 0) return cleared;
    try {
      await this.stream(this.target, `cd ${dir} && tar -xzf -`, fs.readFileSync(tarFile));
      return { code: 0, stdout: "imported", stderr: "" };
    } catch (err) {
      return { code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  }
  async unregister(osName: string): Promise<RunnerResult> {
    // Removing the remote dir would destroy the data restore needs; only explicit remove() deletes it.
    void osName;
    return { code: 0, stdout: "kept", stderr: "" };
  }
  async destroy(osName: string): Promise<RunnerResult> {
    // remove() is explicit and final: delete the whole remote directory and verify it is gone.
    const dir = JSON.stringify(this.remoteDir(osName));
    const res = await this.ssh(this.target, `rm -rf ${dir} && test ! -e ${dir}`);
    return res.code === 0 ? { code: 0, stdout: "destroyed", stderr: "" } : res;
  }
  /** The remote host owns its power state; "terminate" only ends nothing here. */
  async terminate(_osName: string): Promise<RunnerResult> {
    return { code: 0, stdout: "", stderr: "" };
  }
  async exportDevice(osName: string, tarFile: string): Promise<RunnerResult> {
    const res = await this.ssh(this.target, `cd ${JSON.stringify(this.remoteDir(osName))} && tar -czf - . | wc -c`);
    if (res.code !== 0) return res;
    try {
      const buf = await this.stream(this.target, `cd ${JSON.stringify(this.remoteDir(osName))} && tar -czf - .`);
      fs.mkdirSync(path.dirname(tarFile), { recursive: true });
      fs.writeFileSync(tarFile, buf);
      return { code: 0, stdout: "", stderr: "" };
    } catch (err) {
      return { code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  }
  async exec(osName: string, user: string, command: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<RunnerResult> {
    // Run inside the device's directory on the remote host.
    void user;
    const res = await this.ssh(this.target, `cd ${JSON.stringify(this.remoteDir(osName))} && bash -lc ${JSON.stringify(command)}`, Math.min(timeoutMs ?? 120_000, 600_000), signal);
    return res;
  }
}

/** SSH provider selection: LOAM_SSH_DEVICE=user@host:port with LOAM_SSH_BASE_DIR. */
export function sshTargetFromEnv(): SshTarget | undefined {
  const raw = process.env.LOAM_SSH_DEVICE;
  if (!raw) return undefined;
  let user: string | undefined;
  let hostPort = raw;
  const at = raw.lastIndexOf("@");
  if (at > 0) {
    user = raw.slice(0, at);
    hostPort = raw.slice(at + 1);
  }
  const [host, port] = hostPort.split(":");
  if (!host) return undefined;
  return { host, ...(port ? { port: Number(port) } : {}), ...(user ? { user } : {}), baseDir: process.env.LOAM_SSH_BASE_DIR || "/tmp/loam-devices" };
}

export const sshRunnerForTests = (target: SshTarget, ssh: SshDeviceRunner["ssh"], stream?: SshDeviceRunner["stream"]): SshDeviceRunner => new SshDeviceRunner(target, ssh, stream);

export function getDeviceRunner(): DeviceRunner {
  if (process.env.LOAM_DEVICE_RUNNER === "fake") return fakeRunner;
  const sshTarget = sshTargetFromEnv();
  if (sshTarget) return new SshDeviceRunner(sshTarget);
  return new RealDeviceRunner();
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export interface DeviceTemplateDef {
  id: string;
  labelAr: string;
  description: string;
  environment: DeviceEnvironment;
  /** Bash setup executed as root right after import (Linux templates). */
  setup: string[];
}

const loamUserSetup = [
  "id -u loam >/dev/null 2>&1 || useradd -m -s /bin/bash loam",
  "printf '[user]\ndefault=loam\n[automount]\nenabled=false\n[interop]\nenabled=false\n' > /etc/wsl.conf",
];

export const DEVICE_TEMPLATES: DeviceTemplateDef[] = [
  { id: "research", labelAr: "بحث", description: "بيئة بحث: python وcurl وjq لأعمال البحث والتقارير", environment: "linux",
    setup: [...loamUserSetup, "apt-get update -qq || true", "apt-get install -y -qq curl jq python3 python3-pip >/dev/null 2>&1 || true"] },
  { id: "coding", labelAr: "برمجة", description: "بيئة تطوير: git وnode وpython وأدوات بناء", environment: "linux",
    setup: [...loamUserSetup, "apt-get update -qq || true", "apt-get install -y -qq git build-essential python3 python3-pip >/dev/null 2>&1 || true", "command -v node >/dev/null 2>&1 || (curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - >/dev/null 2>&1 && apt-get install -y -qq nodejs >/dev/null 2>&1) || true"] },
  { id: "office", labelAr: "أوفيس", description: "بيئة مستندات: libreoffice وpandoc لمعالجة الملفات والتحويل", environment: "linux",
    setup: [...loamUserSetup, "apt-get update -qq || true", "apt-get install -y -qq libreoffice pandoc >/dev/null 2>&1 || true"] },
  { id: "design", labelAr: "تصميم", description: "بيئة تصميم: imagemagick وffmpeg لمعالجة الصور والفيديو", environment: "linux",
    setup: [...loamUserSetup, "apt-get update -qq || true", "apt-get install -y -qq imagemagick ffmpeg fonts-noto-core >/dev/null 2>&1 || true"] },
];

export function getDeviceTemplate(id: string): DeviceTemplateDef {
  const t = DEVICE_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown device template: ${id}`);
  return t;
}

export const DEVICE_USER = "loam";

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

const FILE = path.join(DATA_DIR, "companion-devices.json");
const DEVICES_ROOT = path.join(DATA_DIR, "devices");
let devices: CompanionDeviceRecord[] = [];

const goldenTar = (): string => path.join(DEVICES_ROOT, "golden-linux.tar");

function save(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 1), "utf8");
    fs.renameSync(tmp, FILE);
  } catch (err) {
    log.warn(`companion-devices: save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function loadCompanionDevices(): void {
  try {
    if (!fs.existsSync(FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8")) as { devices?: CompanionDeviceRecord[] };
    devices = (parsed.devices ?? []).filter((d) => d && typeof d.id === "string" && d.state !== "deleted");
  } catch {
    devices = [];
  }
}

export function listDevices(): CompanionDeviceRecord[] {
  return [...devices].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getDevice(id: string): CompanionDeviceRecord | undefined {
  return devices.find((d) => d.id === id);
}

export function getDeviceByAgent(agentId: string): CompanionDeviceRecord | undefined {
  return [...devices].filter((d) => d.agentId === agentId && d.state !== "deleted").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/* ------------------------------------------------------------------ */
/* Journal                                                             */
/* ------------------------------------------------------------------ */

function journalFile(device: CompanionDeviceRecord): string {
  return path.join(device.storagePath, "journal.jsonl");
}

function journal(device: CompanionDeviceRecord, kind: DeviceJournalEntry["kind"], event: string, ok: boolean, detail?: string): void {
  try {
    fs.mkdirSync(device.storagePath, { recursive: true });
    fs.appendFileSync(journalFile(device), `${JSON.stringify({ at: new Date().toISOString(), kind, event, ok, ...(detail ? { detail: detail.slice(0, 2000) } : {}) })}\n`, "utf8");
  } catch {
    /* journal must never break device ops */
  }
}

export function readJournal(device: CompanionDeviceRecord, limit = 60): DeviceJournalEntry[] {
  try {
    if (!fs.existsSync(journalFile(device))) return [];
    return fs.readFileSync(journalFile(device), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as DeviceJournalEntry).slice(-limit);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Manager                                                             */
/* ------------------------------------------------------------------ */

export type DeviceOpError = { error: string };

export class DeviceManager {
  constructor(private readonly runner: DeviceRunner) {}

  async providers(): Promise<DeviceProviders> {
    return this.runner.detect();
  }

  /** One-time base rootfs preparation for cloning (real runner only). */
  async prepareGolden(fromDistro: string): Promise<{ ok: boolean; file: string; error?: string }> {
    const file = goldenTar();
    if (fs.existsSync(file)) return { ok: true, file };
    if (this.runner.kind === "fake") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "FAKE-GOLDEN");
      return { ok: true, file };
    }
    const res = await this.runner.exportDevice(fromDistro, file);
    if (res.code !== 0) return { ok: false, file, error: res.stderr || res.stdout || "wsl --export failed" };
    return { ok: true, file };
  }

  goldenReady(): boolean {
    return fs.existsSync(goldenTar());
  }

  async create(input: { agentId: string; template: string; name?: string; resources?: Partial<DeviceResources> }): Promise<CompanionDeviceRecord | DeviceOpError> {
    if (devices.some((d) => d.agentId === input.agentId && d.state !== "deleted" && d.state !== "error")) {
      return { error: "يوجد جهاز فعّال لهذا المساعد بالفعل — احذفه أو استبدله أولًا" };
    }
    const template = getDeviceTemplate(input.template); // throws on unknown → caller maps to 400
    if (template.environment === "windows") {
      return { error: "قوالب Windows تتطلب مزود Hyper-V — التوفير عبر WSL2 مدعوم في هذه المرحلة، وقوالب Windows حدّ مسجل في المستند" };
    }
    const providers = await this.runner.detect();
    if (!providers.wsl && this.runner.kind !== "fake") {
      return { error: "لا يوجد مزود أجهزة متاح على هذا الجهاز (WSL2 غير مثبّت وHyper-V دون أداة توفير) — راجع متطلبات التشغيل" };
    }
    const id = `dev_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
    const storagePath = path.join(DEVICES_ROOT, id);
    fs.mkdirSync(storagePath, { recursive: true });
    const now = new Date().toISOString();
    const device: CompanionDeviceRecord = {
      id,
      agentId: input.agentId,
      name: (input.name ?? `جهاز ${template.labelAr}`).trim().slice(0, 80),
      environment: template.environment,
      provider: this.runner.kind,
      template: template.id,
      resources: { cpus: Math.max(1, Math.min(16, input.resources?.cpus ?? 4)), memoryMB: Math.max(1024, Math.min(65536, input.resources?.memoryMB ?? 8192)), diskGB: Math.max(8, Math.min(512, input.resources?.diskGB ?? 64)) },
      state: "provisioning",
      osName: `loam-device-${id}`,
      storagePath,
      controlHeldBy: "agent",
      snapshots: [],
      createdAt: now,
      updatedAt: now,
    };
    devices.push(device);
    save();
    journal(device, "system", "create", true, `template=${template.id} provider=${device.provider}`);
    // Provisioning is async: import → setup → ready. State transitions are
    // persisted so the UI (and the gate) can poll.
    void this.provision(device, template).catch((err) => {
      device.state = "error";
      device.lastError = err instanceof Error ? err.message : String(err);
      device.updatedAt = new Date().toISOString();
      save();
      journal(device, "system", "provision-error", false, device.lastError);
    });
    return device;
  }

  private async provision(device: CompanionDeviceRecord, template: DeviceTemplateDef): Promise<void> {
    const golden = goldenTar();
    if (!fs.existsSync(golden)) {
      if (this.runner.kind === "fake") {
        await this.prepareGolden("Ubuntu-24.04");
      } else {
        throw new Error(`لا توجد صورة أساس (golden) للتزويد — جهّزها مرة واحدة عبر POST /api/companion-devices/golden ثم أعد الإنشاء`);
      }
    }
    const imported = await this.runner.importDevice(device.osName, device.storagePath, golden);
    if (imported.code !== 0) throw new Error(`فشل استيراد الجهاز: ${imported.stderr || imported.stdout || "wsl --import failed"}`);
    journal(device, "system", "import", true);
    for (const step of template.setup) {
      const res = await this.runner.exec(device.osName, "root", step, 10 * 60_000);
      if (res.code !== 0) {
        // Setup steps are best-effort (apt may be offline); the device still boots.
        journal(device, "system", "setup-step", false, `${step.slice(0, 120)} → ${res.stderr.slice(0, 200)}`);
      }
    }
    journal(device, "system", "setup", true, `${template.setup.length} steps`);
    const ready = await this.runner.exec(device.osName, DEVICE_USER, "echo loam-ready", 30_000);
    device.state = ready.code === 0 ? "running" : "error";
    if (ready.code !== 0) device.lastError = `الجهاز مسجل لكن فحص الجاهزية فشل: ${ready.stderr || ready.stdout}`;
    device.updatedAt = new Date().toISOString();
    save();
    journal(device, "system", "provision-done", device.state === "running", device.state === "running" ? "ready" : device.lastError);
  }

  async start(id: string): Promise<CompanionDeviceRecord | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    if (device.state === "running") return device;
    if (!["stopped", "suspended", "error"].includes(device.state)) return { error: `لا يمكن تشغيل جهاز في حالة ${device.state}` };
    const res = await this.runner.exec(device.osName, DEVICE_USER, "echo loam-ready", 60_000);
    device.state = res.code === 0 ? "running" : "error";
    if (res.code !== 0) device.lastError = res.stderr || "start readiness failed";
    device.updatedAt = new Date().toISOString();
    save();
    journal(device, "system", "start", res.code === 0, res.code === 0 ? "ready" : device.lastError);
    return device;
  }

  async stop(id: string): Promise<CompanionDeviceRecord | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    if (device.state !== "running") return { error: `الجهاز ليس قيد التشغيل (حالته ${device.state})` };
    const res = await this.runner.terminate(device.osName);
    // Terminate ends processes; the vhdx (persistent storage) stays untouched.
    device.state = "stopped";
    device.updatedAt = new Date().toISOString();
    save();
    journal(device, "system", "stop", res.code === 0, "disk persists");
    return device;
  }

  /** WSL has no per-distro memory suspend: suspend ends processes like stop but
   *  keeps a distinct state so resume UX and docs stay honest about it. */
  async suspend(id: string): Promise<CompanionDeviceRecord | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    if (device.state !== "running") return { error: `لا يمكن تعليق جهاز في حالة ${device.state}` };
    await this.runner.terminate(device.osName);
    device.state = "suspended";
    device.updatedAt = new Date().toISOString();
    save();
    journal(device, "system", "suspend", true, "processes stopped, disk persists");
    return device;
  }

  async resume(id: string): Promise<CompanionDeviceRecord | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    if (device.state !== "suspended" && device.state !== "stopped") return { error: `لا يمكن استئناف جهاز في حالة ${device.state}` };
    return this.start(id);
  }

  /* -------- live GUI viewer (stage 2 completion): a real X desktop inside the
     device (Xvfb + fluxbox + xterm), streamed as MJPEG frames captured with
     ffmpeg x11grab, and manual pointer/keyboard control via xdotool under the
     take-control interlock. -------------------------------------------- */

  /** Idempotent: boots the X session inside the device if not already up. */
  async ensureGui(id: string): Promise<{ ok: boolean; started: boolean; detail: string } | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    if (device.state !== "running") return { error: `الجهاز ليس قيد التشغيل (حالته ${device.state})` };
    const script = [
      "if [ -f /tmp/.loam-gui-ready ]; then echo ready; exit 0; fi",
      "mkdir -p /tmp/.X11-unix && chmod 1777 /tmp /tmp/.X11-unix",
      "export DISPLAY=:99",
      // nohup+setsid: daemons must survive the wsl.exe session that spawned them.
      "nohup setsid Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &",
      "sleep 1",
      "nohup setsid fluxbox >/tmp/fluxbox.log 2>&1 &",
      "nohup setsid xterm -geometry 100x30+60+50 -title 'Loam Companion Device' >/tmp/xterm.log 2>&1 &",
      "sleep 1",
      // Only declare success once a window manager actually owns the display.
      "if ! DISPLAY=:99 wmctrl -m >/dev/null 2>&1; then echo gui-failed; head -20 /tmp/xvfb.log /tmp/fluxbox.log 2>/dev/null; exit 1; fi",
      "touch /tmp/.loam-gui-ready && echo started",
    ].join("\n");
    const res = await this.runner.exec(device.osName, DEVICE_USER, script, 30_000);
    if (res.code !== 0) {
      journal(device, "system", "gui-start", false, res.stderr.slice(0, 300));
      return { ok: false, started: false, detail: res.stderr || res.stdout || "فشل تشغيل سطح المكتب داخل الجهاز — تأكد أن صورة الأساس تحمل حزمة الواجهة (Xvfb/fluxbox/xterm/ffmpeg/xdotool)" };
    }
    journal(device, "system", "gui-start", true, res.stdout.trim());
    return { ok: true, started: res.stdout.includes("started"), detail: res.stdout.trim() };
  }

  async guiReady(id: string): Promise<boolean> {
    const device = getDevice(id);
    if (!device) return false;
    const res = await this.runner.exec(device.osName, DEVICE_USER, "test -f /tmp/.loam-gui-ready && echo gui-up", 15_000);
    return res.code === 0 && res.stdout.includes("gui-up");
  }

  /** One real frame from the device screen, JPEG bytes. */
  async captureScreen(id: string, ensure = true): Promise<Buffer | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    if (device.state !== "running") return { error: `الجهاز ليس قيد التشغيل (حالته ${device.state})` };
    if (ensure && !(await this.guiReady(id))) {
      const boot = await this.ensureGui(id);
      if ("error" in boot || !boot.ok) return "error" in boot ? boot : { error: boot.detail };
    }
    const res = await this.runner.exec(
      device.osName,
      DEVICE_USER,
      "ffmpeg -nostats -loglevel error -y -f x11grab -video_size 1280x800 -i :99 -frames:v 1 -f mjpeg pipe:1 2>/tmp/ffmpeg-cap.log | base64 -w0",
      30_000,
    );
    if (res.code !== 0 || !res.stdout.trim()) return { error: `تعذر التقاط الشاشة: ${res.stderr || "ffmpeg x11grab failed"}` };
    const buf = Buffer.from(res.stdout, "base64");
    if (buf.length < 50) return { error: "إطار الشاشة الملتقط غير سليم" };
    return buf;
  }

  /** Manual pointer/keyboard input — only while the user holds control. */
  async sendGuiInput(id: string, input: { type: "click" | "doubleclick" | "rightclick" | "move" | "type" | "key" | "scroll"; x?: number; y?: number; text?: string; key?: string; button?: number }): Promise<true | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    if (device.controlHeldBy !== "user") return { error: "تولَّ التحكم بالجهاز أولًا قبل إرسال مدخلات" };
    const coord = (n: unknown): number => Math.max(0, Math.min(1280, Math.round(Number(n))));
    let command = "";
    switch (input.type) {
      case "move":
        command = `DISPLAY=:99 xdotool mousemove --sync ${coord(input.x)} ${coord(input.y)}`;
        break;
      case "click":
      case "doubleclick":
      case "rightclick": {
        const btn = input.type === "rightclick" ? 3 : 1;
        const repeat = input.type === "doubleclick" ? "click --repeat 2 --delay 120" : "click";
        command = `DISPLAY=:99 xdotool mousemove --sync ${coord(input.x)} ${coord(input.y)} ${repeat} ${btn}`;
        break;
      }
      case "scroll":
        command = `DISPLAY=:99 xdotool mousemove --sync ${coord(input.x)} ${coord(input.y)} click --wheel ${Number(input.y) < 400 ? 4 : 5}`;
        break;
      case "type": {
        const text = String(input.text ?? "").slice(0, 2000);
        if (!text) return { error: "text مطلوب" };
        if (text.includes("'")) return { error: "النص لا يدعم الفاصلة العليا حاليًا — استخدم الكتابة على دفعات" };
        command = `TEXT=$(printf %s ${Buffer.from(text, "utf8").toString("base64")} | base64 -d); DISPLAY=:99 xdotool type --clearmodifiers --delay 25 -- "$TEXT"`;
        break;
      }
      case "key": {
        const key = String(input.key ?? "").trim();
        if (!/^[a-zA-Z0-9_+-]{1,40}$/.test(key)) return { error: "مفتاح غير صالح" };
        command = `DISPLAY=:99 xdotool key --clearmodifiers ${key}`;
        break;
      }
    }
    const res = await this.runner.exec(device.osName, DEVICE_USER, command, 20_000);
    journal(device, "user", `gui:${input.type}`, res.code === 0, res.code === 0 ? `${input.x ?? ""}${input.y ?? ""}${input.key ?? ""}`.trim() : res.stderr.slice(0, 200));
    if (res.code !== 0) return { error: `فشل تنفيذ المدخلة داخل الجهاز: ${res.stderr || "xdotool failed"}` };
    return true;
  }

  /** Open application windows on the device screen (watch what is running). */
  async guiWindows(id: string): Promise<Array<{ handle: string; desktop: number; title: string }> | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    if (!(await this.guiReady(id))) return [];
    const res = await this.runner.exec(device.osName, DEVICE_USER, "DISPLAY=:99 wmctrl -l", 15_000);
    if (res.code !== 0) return { error: `تعذر عرض النوافذ: ${res.stderr}` };
    journal(device, "system", "gui-windows", true);
    return res.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = /^(\S+)\s+(\d+)\s+\S+\s+(.*)$/.exec(line);
        return m ? { handle: m[1]!, desktop: Number(m[2]), title: m[3]! } : { handle: line.slice(0, 12), desktop: 0, title: line };
      });
  }

  async isReady(id: string): Promise<{ ready: boolean; detail: string }> {
    const device = getDevice(id);
    if (!device) return { ready: false, detail: "الجهاز غير موجود" };
    const res = await this.runner.exec(device.osName, DEVICE_USER, "echo loam-ready", 30_000);
    return { ready: res.code === 0 && res.stdout.includes("loam-ready"), detail: res.code === 0 ? res.stdout : res.stderr || "readiness exec failed" };
  }

  async snapshot(id: string, label: string): Promise<CompanionDeviceRecord | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    if (device.state === "provisioning" || device.state === "error") return { error: `لا يمكن إنشاء نقطة استعادة لجهاز في حالة ${device.state}` };
    if (device.state === "running") {
      // Export needs a quiet distro: terminate first (disk persists), device ends "stopped".
      await this.runner.terminate(device.osName);
      device.state = "stopped";
      journal(device, "system", "auto-stop-for-snapshot", true);
    }
    const snapId = `snap_${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
    const file = path.join(device.storagePath, "snapshots", `${snapId}.tar`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const res = await this.runner.exportDevice(device.osName, file);
    if (res.code !== 0) return { error: `فشل تصدير نقطة الاستعادة: ${res.stderr || "wsl --export failed"}` };
    const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    device.snapshots = [...device.snapshots, { id: snapId, label: label.trim().slice(0, 120) || `نقطة ${device.snapshots.length + 1}`, at: new Date().toISOString(), file: path.relative(device.storagePath, file).split(path.sep).join("/"), bytes }];
    device.updatedAt = new Date().toISOString();
    save();
    journal(device, "system", "snapshot", true, `${snapId} (${bytes} bytes)`);
    return device;
  }

  async restore(id: string, snapshotId: string): Promise<CompanionDeviceRecord | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    const snap = device.snapshots.find((s) => s.id === snapshotId);
    if (!snap) return { error: "نقطة الاستعادة غير موجودة" };
    if (device.state === "running" || device.state === "suspended") return { error: "أوقف الجهاز قبل الاستعادة" };
    const tar = path.join(device.storagePath, snap.file);
    if (!fs.existsSync(tar)) return { error: "ملف نقطة الاستعادة مفقود من التخزين" };
    // Validate the archive BEFORE destroying the current state (prevent data loss
    // when a corrupted tar would leave the device unregistered with nothing to import).
    const stat = fs.statSync(tar);
    if (stat.size < 200) return { error: "ملف نقطة الاستعادة تالف أو فارغ — أُلغيت الاستعادة قبل المساس بالجهاز الحالي" };
    journal(device, "system", "restore-begin", true, snapshotId);
    const un = await this.runner.unregister(device.osName);
    if (un.code !== 0) return { error: `فشل إلغاء تسجيل الجهاز الحالي: ${un.stderr || "wsl --unregister failed"}` };
    const im = await this.runner.importDevice(device.osName, device.storagePath, tar);
    if (im.code !== 0) {
      device.state = "error";
      device.lastError = `فشلت الاستعادة: ${im.stderr || "import failed"}`;
      save();
      journal(device, "system", "restore-failed", false, device.lastError);
      return { error: device.lastError };
    }
    device.state = "stopped";
    device.updatedAt = new Date().toISOString();
    save();
    journal(device, "system", "restore-done", true, `restored ${snapshotId}`);
    return device;
  }

  async remove(id: string, confirm: boolean): Promise<{ deleted: boolean } | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    if (!confirm) return { error: "حذف الجهاز وبياناته إجراء نهائي — أكّد الحذف صراحةً (confirm=true)" };
    // destroy() deletes the device data for good (wsl --unregister, remote rm -rf);
    // runners without destroy fall back to unregister, which on wsl IS destructive.
    const res = await (this.runner.destroy ? this.runner.destroy(device.osName) : this.runner.unregister(device.osName));
    if (res.code !== 0 && this.runner.kind !== "fake") {
      return { error: `فشل حذف الجهاز من المزود: ${res.stderr || "destroy failed"}` };
    }
    devices = devices.filter((x) => x.id !== id);
    save();
    try {
      fs.rmSync(device.storagePath, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return { deleted: true };
  }

  /* -------- resource ceilings + idle auto-stop (3-4/23): protects the host
     from a runaway companion device and stops forgotten idle ones. -------- */
  async scanAndSuspendIdle(idleMinutes = 30): Promise<Array<{ id: string; name: string; action: "suspended-idle" | "suspended-resource" | "left-running"; reason: string }>> {
    const actions: Array<{ id: string; name: string; action: "suspended-idle" | "suspended-resource" | "left-running"; reason: string }> = [];
    for (const device of listDevices()) {
      if (device.state !== "running") continue;
      try {
        const stats = await this.stats(device.id);
        const memUsedMB = "error" in stats ? undefined : stats.memoryTotalMB !== undefined && stats.memoryFreeMB !== undefined ? stats.memoryTotalMB - stats.memoryFreeMB : undefined;
        if (memUsedMB !== undefined && memUsedMB > device.resources.memoryMB) {
          await this.runner.terminate(device.osName);
          device.state = "suspended";
          device.updatedAt = new Date().toISOString();
          save();
          journal(device, "system", "auto-suspend-resource", true, `mem ${memUsedMB}MB > حد ${device.resources.memoryMB}MB`);
          actions.push({ id: device.id, name: device.name, action: "suspended-resource", reason: `الذاكرة المستخدمة ${memUsedMB}MB تجاوزت حد الجهاز ${device.resources.memoryMB}MB` });
          continue;
        }
        const idleMs = Date.now() - Date.parse(device.updatedAt);
        if (idleMs > idleMinutes * 60_000) {
          await this.runner.terminate(device.osName);
          device.state = "suspended";
          device.updatedAt = new Date().toISOString();
          save();
          journal(device, "system", "auto-suspend-idle", true, `idle ${Math.round(idleMs / 60000)}m`);
          actions.push({ id: device.id, name: device.name, action: "suspended-idle", reason: `خامل ${Math.round(idleMs / 60_000)} دقيقة — أُوقف للحفاظ على الموارد (القرص يبقى)` });
          continue;
        }
        actions.push({ id: device.id, name: device.name, action: "left-running", reason: `نشط (خامل ${Math.round(idleMs / 60_000)} دقيقة)` });
      } catch {
        actions.push({ id: device.id, name: device.name, action: "left-running", reason: "تعذر قراءة الحالة" });
      }
    }
    return actions;
  }

  /* -------- execution (agent tools + user take-control console) -------- */

  /** Base64 payloads written via the printf|base64 protocol can decode to secrets; never journal them.
   *  Any length is redacted — a 1-3 char secret is still a secret once decoded. */
  private scrub(command: string): string {
    return command.slice(0, 120).replace(/printf %s [A-Za-z0-9+/=]+/g, "printf %s [redacted]");
  }

  /** Command output can echo decoded secrets back; redact echoed printf payloads and
   *  long base64-looking runs before journaling. */
  private scrubOutput(out: string): string {
    return out.slice(0, 200)
      .replace(/printf %s [A-Za-z0-9+/=]+/g, "printf %s [redacted]")
      .replace(/[A-Za-z0-9+/=]{16,}/g, "[redacted]");
  }

  async agentExec(device: CompanionDeviceRecord, command: string, timeoutMs?: number): Promise<RunnerResult | DeviceOpError> {
    if (device.controlHeldBy === "user") {
      return { error: "المستخدم يتولى التحكم بالجهاز الآن — أُرجئ تنفيذ أوامر المساعد حتى إعادة التحكم" };
    }
    const controller = new AbortController();
    const active = this.activeAgentExecs.get(device.id) ?? new Set<AbortController>();
    this.activeAgentExecs.set(device.id, active);
    active.add(controller);
    let res: { code: number; stdout: string; stderr: string };
    try {
      res = await this.runner.exec(device.osName, DEVICE_USER, command, timeoutMs, controller.signal);
    } finally {
      active.delete(controller);
      if (!active.size) this.activeAgentExecs.delete(device.id);
    }
    if (controller.signal.aborted) return { error: "أُلغي الأمر لأن المستخدم تولّى التحكم أثناء تنفيذه" };
    journal(device, "agent", this.scrub(command), res.code === 0, this.scrubOutput(res.code === 0 ? res.stdout : res.stderr));
    return res;
  }

  async userExec(device: CompanionDeviceRecord, command: string, timeoutMs?: number): Promise<RunnerResult | DeviceOpError> {
    if (device.controlHeldBy !== "user") {
      return { error: "تولَّ التحكم بالجهاز أولًا قبل تنفيذ أوامر يدوية" };
    }
    const res = await this.runner.exec(device.osName, DEVICE_USER, command, timeoutMs);
    journal(device, "user", this.scrub(command), res.code === 0, this.scrubOutput(res.code === 0 ? res.stdout : res.stderr));
    return res;
  }

  /** In-flight agent execs per device id; user takeover aborts them — the signal kills the process. */
  private readonly activeAgentExecs = new Map<string, Set<AbortController>>();

  setControl(id: string, holder: "agent" | "user"): CompanionDeviceRecord | DeviceOpError {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    device.controlHeldBy = holder;
    device.updatedAt = new Date().toISOString();
    if (holder === "user") {
      // Taking control must kill the command already running, not just future ones.
      const aborts = this.activeAgentExecs.get(id);
      if (aborts?.size) {
        journal(device, "system", "control-taken-abort", true, String(aborts.size));
        for (const controller of aborts) { try { controller.abort(); } catch { /* best effort */ } }
      }
    }
    save();
    journal(device, "system", holder === "user" ? "control-taken" : "control-released", true);
    return device;
  }

  /* -------- viewer file transfer (not control-gated: upload/download is how
     the user moves files to/from the device without taking control) -------- */

  async listFiles(id: string, dir: string): Promise<string | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    const res = await this.runner.exec(device.osName, DEVICE_USER, `ls -la --time-style=+long-iso ${JSON.stringify(dir)}`, 30_000);
    if (res.code !== 0) return { error: `تعذر عرض ${dir}: ${res.stderr}` };
    journal(device, "system", "list-files", true, dir);
    return res.stdout || "(مجلد فارغ)";
  }

  async readFile(id: string, pathInDevice: string): Promise<Buffer | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    const res = await this.runner.exec(device.osName, DEVICE_USER, `base64 -w0 ${JSON.stringify(pathInDevice)}`, 60_000);
    if (res.code !== 0) return { error: `تعذر قراءة ${pathInDevice}: ${res.stderr}` };
    journal(device, "system", "read-file", true, pathInDevice);
    return Buffer.from(res.stdout, "base64");
  }

  async writeFile(id: string, pathInDevice: string, content: Buffer): Promise<true | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    const dir = path.posix.dirname(pathInDevice);
    const res = await this.runner.exec(device.osName, DEVICE_USER, `mkdir -p ${JSON.stringify(dir)} && printf %s ${content.toString("base64")} | base64 -d > ${JSON.stringify(pathInDevice)}`, 120_000);
    if (res.code !== 0) return { error: `تعذر كتابة ${pathInDevice}: ${res.stderr}` };
    journal(device, "system", "write-file", true, `${pathInDevice} (${content.length} bytes)`);
    return true;
  }

  async stats(id: string): Promise<{ memoryTotalMB?: number; memoryFreeMB?: number; disk?: string; raw: string } | DeviceOpError> {
    const device = getDevice(id);
    if (!device) return { error: "الجهاز غير موجود" };
    const res = await this.runner.exec(device.osName, DEVICE_USER, "cat /proc/meminfo | head -2; echo ---; df -h / | tail -1", 30_000);
    if (res.code !== 0) return { error: `تعذر قراءة موارد الجهاز: ${res.stderr || "stats exec failed"}` };
    const memTotal = /MemTotal:\s+(\d+) kB/.exec(res.stdout);
    const memFree = /MemFree:\s+(\d+) kB/.exec(res.stdout);
    const diskLine = res.stdout.split("---").pop()?.trim() ?? "";
    return {
      ...(memTotal ? { memoryTotalMB: Math.round(Number(memTotal[1]) / 1024) } : {}),
      ...(memFree ? { memoryFreeMB: Math.round(Number(memFree[1]) / 1024) } : {}),
      ...(diskLine ? { disk: diskLine } : {}),
      raw: res.stdout.slice(0, 2000),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Singleton used by the server                                        */
/* ------------------------------------------------------------------ */

export const deviceManager = new DeviceManager(getDeviceRunner());
