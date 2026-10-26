// src/appbuilder/devServer.ts
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import type { AppProject, DevServerStatus } from "./types.js";
import { appProcessEnv } from "./processEnv.js";
import { BRIDGE_PREFIX, recordRuntimeError } from "./runtimeErrors.js";

export const DEV_PORT_RANGE: [number, number] = [15173, 15299]; // away from 5173, the default of a user's own Vite projects
export const API_PORT_RANGE: [number, number] = [18787, 18899]; // 8787 is taken by Loam's Agent Studio backend (electron/main.cjs:104)
export const READY_TIMEOUT_MS = 30_000;
export const MAX_RUNNING_DEV_SERVERS = 3;
export const LOG_RING_LINES = 500;

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

export async function findFreePort([from, to]: [number, number], taken: Set<number>): Promise<number> {
  for (let p = from; p <= to; p++) if (!taken.has(p) && (await isPortFree(p))) return p;
  throw new Error(`no free port in ${from}-${to}`);
}

function killTree(child: ChildProcess | null): void {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGTERM");
}

interface Running {
  status: DevServerStatus;
  vite: ChildProcess | null;
  api: ChildProcess | null;
  apiPort: number | null;
  log: string[];
  lastUsed: number;
  restarts: number;
}

export interface DevServerHooks {
  onStatus(status: DevServerStatus): void;
  /** The user's own AI provider settings for the fullstack API server only (§4.10.4). Empty object when no key is saved.
   *  Never passed to the Vite process: Vite exposes only VITE_-prefixed variables to the browser, and these names have no such prefix. */
  aiEnv(project: AppProject): Record<string, string>;
}

export class DevServerManager {
  private running = new Map<string, Running>();

  constructor(private hooks: DevServerHooks) {}

  status(projectId: string): DevServerStatus {
    return this.running.get(projectId)?.status ?? { projectId, state: "stopped", url: null, port: null, pid: null, startedAt: null, lastError: null };
  }

  logTail(projectId: string, lines = 200): string[] {
    return (this.running.get(projectId)?.log ?? []).slice(-lines);
  }

  apiPort(projectId: string): number | null {
    return this.running.get(projectId)?.apiPort ?? null;
  }

  private takenPorts(): Set<number> {
    const s = new Set<number>();
    for (const r of this.running.values()) { if (r.status.port) s.add(r.status.port); if (r.apiPort) s.add(r.apiPort); }
    return s;
  }

  private push(r: Running, project: AppProject, chunk: string): void {
    for (const raw of chunk.replace(/\r\n/g, "\n").split("\n")) {
      const line = raw.trimEnd();
      if (!line) continue;
      if (line.startsWith(BRIDGE_PREFIX)) { (() => { const e = JSON.parse(line.slice(BRIDGE_PREFIX.length)); recordRuntimeError(project.id, e); })(); continue; }
      if (/\[vite\].*(error|failed)/i.test(line) || /^\s*(SyntaxError|TypeError|ReferenceError)\b/.test(line)) recordRuntimeError(project.id, { kind: "vite", message: line.slice(0, 2000), stack: null, source: null, url: null });
      r.log.push(line);
      if (r.log.length > LOG_RING_LINES) r.log.splice(0, r.log.length - LOG_RING_LINES);
    }
  }

  async ensure(project: AppProject): Promise<string> {
    const existing = this.running.get(project.id);
    if (existing && existing.status.state === "ready" && existing.status.url) { existing.lastUsed = Date.now(); return existing.status.url; }
    if (existing && existing.status.state === "starting") return this.waitReady(project.id);
    await this.evictIfNeeded();

    const taken = this.takenPorts();
    const port = project.settings.devServerPort ?? (await findFreePort(DEV_PORT_RANGE, taken));
    taken.add(port);
    const appDir = path.join(project.workspaceDir, project.appDir);
    const r: Running = {
      status: { projectId: project.id, state: "starting", url: null, port, pid: null, startedAt: new Date().toISOString(), lastError: null },
      vite: null, api: null, apiPort: null, log: [], lastUsed: Date.now(), restarts: existing?.restarts ?? 0,
    };
    this.running.set(project.id, r);
    this.hooks.onStatus(r.status);

    const env = appProcessEnv(project);

    if (project.features.includes("fullstack")) {
      const apiPort = await findFreePort(API_PORT_RANGE, taken);
      r.apiPort = apiPort;
      env.LOAM_API_PORT = String(apiPort);
      r.api = spawn("node", ["server/index.mjs"], {
        cwd: appDir, windowsHide: true,
        env: { ...env, LOAM_API_PORT: String(apiPort), LOAM_DB_PATH: path.join(appDir, "data", "app.sqlite"), ...this.hooks.aiEnv(project) },
      });
      r.api.stdout?.on("data", (b: Buffer) => this.push(r, project, `[api] ${b.toString("utf8")}`));
      r.api.stderr?.on("data", (b: Buffer) => { const t = b.toString("utf8"); this.push(r, project, `[api] ${t}`); recordRuntimeError(project.id, { kind: "http", message: t.slice(0, 2000), stack: null, source: null, url: null }); });
    }

    r.vite = spawn(NPM, ["run", "dev", "--", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
      cwd: appDir, windowsHide: true, shell: process.platform === "win32", env,
    });
    r.status.pid = r.vite.pid ?? null;
    r.vite.stdout?.on("data", (b: Buffer) => this.push(r, project, b.toString("utf8")));
    r.vite.stderr?.on("data", (b: Buffer) => this.push(r, project, b.toString("utf8")));
    r.vite.on("exit", (code) => {
      if (this.running.get(project.id) !== r || r.status.state === "stopped") return;
      r.status = { ...r.status, state: "crashed", lastError: `dev server exited with code ${code}\n${r.log.slice(-20).join("\n")}` };
      killTree(r.api);
      this.hooks.onStatus(r.status);
      if (r.restarts < 1) { r.restarts += 1; void this.ensure(project).catch(() => undefined); }
    });

    return this.waitReady(project.id);
  }

  private async waitReady(projectId: string): Promise<string> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const r = this.running.get(projectId);
      if (!r || r.status.state === "crashed") throw new Error(r?.status.lastError ?? "dev server stopped");
      if (r.status.state === "ready" && r.status.url) return r.status.url;
      const url = `http://127.0.0.1:${r.status.port}/`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) {
          r.status = { ...r.status, state: "ready", url };
          this.hooks.onStatus(r.status);
          return url;
        }
      } catch { /* not up yet */ }
      await new Promise((res) => setTimeout(res, 250));
    }
    const r = this.running.get(projectId);
    if (r) { r.status = { ...r.status, state: "crashed", lastError: `not ready after ${READY_TIMEOUT_MS} ms\n${r.log.slice(-20).join("\n")}` }; this.hooks.onStatus(r.status); }
    throw new Error("dev_server_timeout");
  }

  private async evictIfNeeded(): Promise<void> {
    const live = [...this.running.entries()].filter(([, r]) => r.status.state === "ready" || r.status.state === "starting");
    if (live.length < MAX_RUNNING_DEV_SERVERS) return;
    live.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const oldest = live[0];
    if (oldest) this.stop(oldest[0]);
  }

  stop(projectId: string): void {
    const r = this.running.get(projectId);
    if (!r) return;
    r.status = { ...r.status, state: "stopped", url: null, pid: null };
    killTree(r.vite);
    killTree(r.api);
    this.hooks.onStatus(r.status);
    this.running.delete(projectId);
  }

  /** Stops only the fullstack API server (used before a database restore, §4.7.3). */
  async stopApi(projectId: string): Promise<void> {
    const r = this.running.get(projectId);
    if (!r?.api) return;
    killTree(r.api);
    r.api = null;
    await new Promise((res) => setTimeout(res, 500));
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }
}
