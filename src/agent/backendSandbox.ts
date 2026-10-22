import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveRead } from "../policy/paths.js";
import { SQLITE_PROBE, validateSqliteChecks, type SqliteCheck, type SqliteCell } from "./sqliteChecks.js";

export interface SandboxResponse { status: number; headers: Record<string, string>; body: string }
export class BackendUnavailable extends Error {
  constructor(message: string) { super(message); this.name = "BackendUnavailable"; }
}
const MAX_BYTES = 2 * 1024 * 1024;

async function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return pending;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Fixed executable/argv; no generated shell command is ever evaluated on the host. */
async function docker(args: string[], input = "", signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", bytes = 0, stopped = false;
    const fail = (e: Error) => { if (stopped) return; stopped = true; child.kill(); clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(e); };
    const abort = () => fail(new Error("Backend sandbox operation aborted"));
    const timer = setTimeout(() => fail(new Error("Backend sandbox operation timed out")), 30_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", fail);
    child.stdin.on("error", e => fail(e));
    for (const [stream, target] of [[child.stdout, "out"], [child.stderr, "err"]] as const) stream.on("data", (b: Buffer) => {
      bytes += b.length;
      if (bytes > MAX_BYTES) { fail(new Error("Backend sandbox output limit exceeded")); return; }
      if (target === "out") out += b.toString("utf8"); else err += b.toString("utf8");
    });
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (stopped) return;
      stopped = true;
      if (code !== 0) reject(new Error(`Docker operation failed (${code}): ${err.slice(0, 1000)}`)); else resolve(out);
    });
    child.stdin.end(input);
  });
}

// Executed INSIDE the network-isolated container. URL authority is fixed;
// redirects stay observable and cannot turn a request into external access.
const BRIDGE = `let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',async()=>{try{
 const q=JSON.parse(input), u=new URL(q.path,'http://127.0.0.1:3000');
 if(u.origin!=='http://127.0.0.1:3000')throw Error('Invalid origin');
 const r=await fetch(u,{method:q.method,headers:q.headers,body:['GET','HEAD'].includes(q.method)?undefined:Buffer.from(q.body,'base64'),redirect:'manual',signal:AbortSignal.timeout(8000)});
 const chunks=[];let size=0;for await(const b of r.body||[]){size+=b.length;if(size>1048576)throw Error('Response too large');chunks.push(b)}
 console.log(JSON.stringify({status:r.status,headers:Object.fromEntries(r.headers),body:Buffer.concat(chunks).toString('base64')}));
 }catch(e){console.error(String(e));process.exitCode=1}});`;

// Observe the supervisor's child through procfs, not an application-writable
// acknowledgement. The container and its tmpfs remain alive throughout.
const RESTART = `const fs=require('node:fs');const entry=process.argv[1];
const children=()=>fs.readFileSync('/proc/1/task/1/children','utf8').trim().split(/\\s+/).filter(Boolean).filter(pid=>{try{return fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0')[1]===entry}catch{return false}});
(async()=>{const before=children();if(before.length!==1)throw Error('Expected one backend child');
process.kill(1,'SIGUSR2');const deadline=Date.now()+8000;
while(Date.now()<deadline){const after=children();if(after.length===1&&after[0]!==before[0]&&!fs.existsSync('/proc/'+before[0])){console.log(JSON.stringify({previousPid:Number(before[0]),currentPid:Number(after[0])}));return}await new Promise(r=>setTimeout(r,50))}
throw Error('Backend process restart timed out')})().catch(e=>{console.error(String(e));process.exitCode=1});`;

/** Ephemeral Node service: no host mounts/socket, no published ports, no external
 * network, unprivileged user, readonly root, bounded resources. Source is copied
 * once; the generated backend can only change its bounded /tmp filesystem. */
export class BackendSandbox {
  private id = "";
  private name = "";
  private sourceContainer = "";
  private sourceImage = "";
  private stage = "";
  readonly sourceHashes: Record<string, string> = {};
  imageId = "";
  private entry = "";
  private restarts = 0;
  private readonly requests = new Set<Promise<SandboxResponse>>();
  private restartGate?: Promise<void>;

  static async start(workspace: string, entry: string, signal?: AbortSignal, lifetimeMs = 180_000): Promise<BackendSandbox> {
    if (!Number.isInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 180_000) throw new Error("Invalid backend lifetime");
    if (!/^[a-zA-Z0-9_./-]+\.(?:mjs|cjs|js)$/.test(entry) || entry.split("/").some(p => p === "..") || entry.startsWith("/")) throw new Error("Invalid backend entry");
    const backend = new BackendSandbox();
    try {
      const sourceEntry = resolveRead(workspace, entry, false);
      if (!fs.statSync(sourceEntry).isFile()) throw new Error("Backend entry missing");
      backend.stage = fs.mkdtempSync(path.join(os.tmpdir(), "loam-backend-source-"));
      let count = 0, bytes = 0;
      const copy = (relative: string) => {
        for (const item of fs.readdirSync(resolveRead(workspace, relative || ".", false), { withFileTypes: true })) {
          if ([".git", ".verification", "node_modules"].includes(item.name) || item.name === ".env" || item.name.startsWith(".env.")) continue;
          const rel = path.join(relative, item.name);
          if (++count > 1000 || item.isSymbolicLink()) throw new Error("Backend snapshot limit or symbolic link rejected");
          const source = resolveRead(workspace, rel, false), target = path.join(backend.stage, rel);
          if (item.isDirectory()) { fs.mkdirSync(target, { recursive: true }); copy(rel); }
          else if (item.isFile()) {
            bytes += fs.statSync(source).size;
            if (bytes > 20 * 1024 * 1024) throw new Error("Backend source exceeds 20 MB");
            const content = fs.readFileSync(source);
            fs.writeFileSync(target, content);
            backend.sourceHashes[rel] = createHash("sha256").update(content).digest("hex");
          } else throw new Error("Unsupported backend source file");
        }
      };
      copy("");
      try {
        backend.imageId = (await docker(["image", "inspect", "node:22-alpine", "--format", "{{.Id}}"], "", signal)).trim();
        if (!/^sha256:[a-f0-9]{64}$/.test(backend.imageId)) throw new Error("Local Node image unavailable");
      } catch (error) {
        signal?.throwIfAborted();
        throw new BackendUnavailable(`Backend verification environment unavailable: ${String(error)}`);
      }
      backend.name = `loam-verify-${randomUUID()}`;
      // A never-started staging container receives the snapshot. Docker cannot
      // copy into a readonly rootfs. Commit it before creating the actual
      // readonly runtime; no generated code runs during this staging phase.
      backend.sourceContainer = `${backend.name}-source`;
      await docker(["create", "--name", backend.sourceContainer, "--network", "none", "--workdir", "/app", "--label", `loam.snapshot=${backend.name}`, backend.imageId, "node"], "", signal);
      await docker(["cp", `${backend.stage}${path.sep}.`, `${backend.sourceContainer}:/app`], "", signal);
      backend.sourceImage = (await docker(["commit", backend.sourceContainer], "", signal)).trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(backend.sourceImage)) throw new Error("Invalid source image identity");
      await docker(["rm", backend.sourceContainer], "", signal); backend.sourceContainer = "";
      backend.entry = `/app/${entry}`;
      const supervisor = `const spawn=require('node:child_process').spawn;let c,restarting=false,restarts=0;
const start=()=>{c=spawn(process.execPath,[process.argv[1]],{stdio:'ignore',detached:true});c.on('error',()=>process.exit(1));c.on('exit',code=>{if(restarting){restarting=false;start()}else process.exit(code||1)})};
process.on('SIGUSR2',()=>{if(restarting||++restarts>2)process.exit(125);restarting=true;try{process.kill(-c.pid,'SIGKILL')}catch{process.exit(1)}});
start();setTimeout(()=>process.exit(124),${lifetimeMs});`;
      backend.id = (await docker(["create", "--name", backend.name, "--label", "loam.verification=backend", "--network", "none", "--log-driver", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", "--pids-limit", "64", "--memory", "256m", "--memory-swap", "256m", "--cpus", "1", "--tmpfs", "/tmp:rw,noexec,nosuid,size=33554432,uid=1000,gid=1000", "--workdir", "/app", "--env", "PORT=3000", "--env", "HOME=/tmp", backend.sourceImage, "node", "-e", supervisor, `/app/${entry}`], "", signal)).trim();
      if (!/^[a-f0-9]{64}$/.test(backend.id)) throw new Error("Invalid sandbox identity");
      await docker(["start", backend.id], "", signal);
      const readyUntil = Date.now() + 5000;
      for (;;) {
        try { await backend.request("/", "GET", {}, "", signal); break; }
        catch (e) { if (signal?.aborted || Date.now() >= readyUntil) throw e; await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      return backend;
    } catch (e) { await backend.close(); throw e; }
  }

  async request(urlPath: string, method = "GET", headers: Record<string, string> = {}, body = "", signal?: AbortSignal): Promise<SandboxResponse> {
    if (this.restartGate) await abortable(this.restartGate, signal);
    signal?.throwIfAborted();
    const pending = this.requestNow(urlPath, method, headers, body, signal);
    this.requests.add(pending);
    try { return await pending; }
    finally { this.requests.delete(pending); }
  }

  private async requestNow(urlPath: string, method = "GET", headers: Record<string, string> = {}, body = "", signal?: AbortSignal): Promise<SandboxResponse> {
    if (!this.id) throw new Error("Backend sandbox closed");
    if (!urlPath.startsWith("/") || urlPath.startsWith("//") || urlPath.includes("\\") || body.length > 1_400_000) throw new Error("Invalid sandbox request");
    const raw = await docker(["exec", "-i", this.id, "node", "-e", BRIDGE], JSON.stringify({ path: urlPath, method, headers, body }), signal);
    const result = JSON.parse(raw) as SandboxResponse;
    if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599 || typeof result.body !== "string" || !result.headers || typeof result.headers !== "object") throw new Error("Invalid backend response");
    return result;
  }

  async inspect(): Promise<Record<string, unknown>> {
    if (!this.id) throw new Error("Backend sandbox closed");
    return JSON.parse(await docker(["inspect", this.id]))[0] as Record<string, unknown>;
  }

  async restart(signal?: AbortSignal): Promise<{ previousPid: number; currentPid: number }> {
    signal?.throwIfAborted();
    if (!this.id) throw new Error("Backend sandbox closed");
    if (this.restartGate) throw new Error("Backend restart already in progress");
    if (this.restarts >= 2) throw new Error("At most two backend restarts per scenario");
    let release!: () => void;
    this.restartGate = new Promise<void>(resolve => { release = resolve; });
    try {
    // No new requests enter the old process after this gate. Drain requests
    // already sent before killing it, without resetting any caller deadline.
    await abortable(Promise.allSettled([...this.requests]), signal);
    signal?.throwIfAborted();
    if (!this.id) throw new Error("Backend sandbox closed");
    this.restarts++;
    const result = JSON.parse(await docker(["exec", this.id, "node", "-e", RESTART, this.entry], "", signal));
    if (!Number.isInteger(result.previousPid) || !Number.isInteger(result.currentPid) || result.previousPid <= 1 || result.currentPid <= 1 || result.previousPid === result.currentPid) throw new Error("Invalid backend restart evidence");
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await this.requestNow("/", "GET", {}, "", signal); return result; }
      catch (e) { if (signal?.aborted || Date.now() >= deadline) throw e; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    } finally { this.restartGate = undefined; release(); }
  }

  async readSqlite(check: SqliteCheck, signal?: AbortSignal): Promise<SqliteCell[][]> {
    if (!this.id) throw new Error("Backend sandbox closed");
    validateSqliteChecks([check]);
    const raw = await docker(["exec", "-i", this.id, "node", "-e", SQLITE_PROBE], JSON.stringify({ database: check.database, table: check.table, columns: check.columns }), signal);
    const rows = JSON.parse(raw);
    validateSqliteChecks([{ ...check, rows }]);
    return rows;
  }

  async close(): Promise<void> {
    const id = this.id || this.name; this.id = ""; this.name = "";
    const sourceContainer = this.sourceContainer, sourceImage = this.sourceImage;
    this.sourceContainer = ""; this.sourceImage = "";
    const errors: unknown[] = [];
    const remove = async (args: string[]) => {
      try { await docker(args); }
      catch (e) { if (!/No such (?:container|image)/i.test(String(e))) errors.push(e); }
    };
    try {
      if (/^(?:[a-f0-9]{64}|loam-verify-[a-f0-9-]{36})$/.test(id)) await remove(["rm", "--force", id]);
      if (/^loam-verify-[a-f0-9-]{36}-source$/.test(sourceContainer)) await remove(["rm", "--force", sourceContainer]);
      if (/^sha256:[a-f0-9]{64}$/.test(sourceImage)) await remove(["image", "rm", sourceImage]);
    }
    finally {
      if (this.stage && path.dirname(this.stage) === os.tmpdir() && path.basename(this.stage).startsWith("loam-backend-source-")) fs.rmSync(this.stage, { recursive: true, force: true });
      this.stage = "";
    }
    if (errors.length) throw new AggregateError(errors, "Backend sandbox cleanup failed");
  }
}
