/**
 * Run store. One directory per run under <DATA_DIR>/security-audits/<repo>/run-<N>/.
 * JSON files are the source of truth; state.sqlite only mirrors stage/agent/budget progress.
 * The parent is the only writer of everything here. Persisted text never carries secrets.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../../config.js";
import { stripSecrets } from "../../memory/redact.js";

export const auditRoot = (): string => path.join(DATA_DIR, "security-audits");

export const slugOf = (name: string): string => {
  const s = name.toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return (s || "repo").slice(0, 48);
};

const RUN_SEP = "--run-";
const known = new Map<string, string>();

/** Deep-clean every string leaf so no secret value reaches disk. */
export function scrub<T>(v: T): T {
  if (typeof v === "string") return stripSecrets(v) as unknown as T;
  if (Array.isArray(v)) return v.map(scrub) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = scrub(x);
    return out as T;
  }
  return v;
}

export function writeAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export interface Stage { run_id: string; stage: string; status: string; started_at: string; finished_at: string | null; error: string | null }

export class RunStore {
  private db: DatabaseSync;
  private constructor(readonly runId: string, readonly dir: string) {
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    this.db = new DatabaseSync(path.join(dir, "state.sqlite"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stages(run_id TEXT, stage TEXT, status TEXT, started_at TEXT, finished_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS agents(agent_id TEXT PRIMARY KEY, run_id TEXT, role TEXT, wave INTEGER, coverage_ids_json TEXT, status TEXT, model TEXT, started_at TEXT, finished_at TEXT, result_path TEXT);
      CREATE TABLE IF NOT EXISTS budget(run_id TEXT PRIMARY KEY, lim INTEGER, spent INTEGER);
    `);
  }

  /** Allocate the next run directory for a repo, or use an explicit output directory. */
  static create(repoName: string, outputDir?: string): RunStore {
    let dir: string;
    let runId: string;
    if (outputDir) {
      dir = path.resolve(outputDir);
      runId = `${slugOf(path.basename(dir))}${RUN_SEP}0`;
    } else {
      const slug = slugOf(repoName);
      const base = path.join(auditRoot(), slug);
      fs.mkdirSync(base, { recursive: true });
      let n = 1;
      for (const d of fs.readdirSync(base)) {
        const m = /^run-(\d+)$/.exec(d);
        if (m) n = Math.max(n, Number(m[1]) + 1);
      }
      for (;;) {
        dir = path.join(base, `run-${n}`);
        try { fs.mkdirSync(dir); break; } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          n++;
        }
      }
      runId = `${slug}${RUN_SEP}${n}`;
    }
    fs.mkdirSync(dir, { recursive: true });
    known.set(runId, dir);
    return new RunStore(runId, dir);
  }

  static open(runId: string): RunStore | null {
    const dir = RunStore.locate(runId);
    return dir ? new RunStore(runId, dir) : null;
  }

  static locate(runId: string): string | null {
    const k = known.get(runId);
    if (k && fs.existsSync(k)) return k;
    const i = runId.lastIndexOf(RUN_SEP);
    if (i <= 0) return null;
    const slug = runId.slice(0, i);
    const n = runId.slice(i + RUN_SEP.length);
    if (!/^[a-z0-9_-]+$/.test(slug) || !/^\d+$/.test(n)) return null;
    const dir = path.join(auditRoot(), slug, `run-${n}`);
    return fs.existsSync(dir) ? dir : null;
  }

  path(...p: string[]): string { return path.join(this.dir, ...p); }

  writeJson(name: string, value: unknown): Buffer {
    const buf = Buffer.from(`${JSON.stringify(scrub(value), null, 2)}\n`, "utf8");
    writeAtomic(this.path(name), buf);
    return buf;
  }
  writeText(name: string, text: string): void { writeAtomic(this.path(name), stripSecrets(text)); }
  readJson<T>(name: string): T | null {
    try { return JSON.parse(fs.readFileSync(this.path(name), "utf8")) as T; } catch { return null; }
  }
  readText(name: string): string | null {
    try { return fs.readFileSync(this.path(name), "utf8"); } catch { return null; }
  }

  stageStart(stage: string): void {
    this.db.prepare("INSERT INTO stages VALUES (?,?,?,?,NULL,NULL)").run(this.runId, stage, "running", new Date().toISOString());
  }
  stageEnd(stage: string, status: "done" | "failed" | "skipped", error?: string): void {
    this.db.prepare("UPDATE stages SET status=?, finished_at=?, error=? WHERE run_id=? AND stage=? AND finished_at IS NULL")
      .run(status, new Date().toISOString(), error ? stripSecrets(error).slice(0, 500) : null, this.runId, stage);
  }
  stages(): Stage[] {
    return this.db.prepare("SELECT * FROM stages WHERE run_id=? ORDER BY rowid").all(this.runId) as unknown as Stage[];
  }
  currentStage(): string {
    const s = this.stages();
    const running = [...s].reverse().find((x) => x.status === "running");
    return running?.stage ?? s[s.length - 1]?.stage ?? "INIT";
  }

  agentRecord(a: { agent_id: string; role: string; wave: number; coverage_ids: string[]; status: string; model?: string; result_path?: string }): void {
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR REPLACE INTO agents VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(a.agent_id, this.runId, a.role, a.wave, JSON.stringify(a.coverage_ids), a.status, a.model ?? "", now, now, a.result_path ?? "");
  }
  setBudget(limit: number | null, spent: number): void {
    this.db.prepare("INSERT OR REPLACE INTO budget VALUES (?,?,?)").run(this.runId, limit === null ? -1 : limit, spent);
  }
  budget(): { spent: number; limit: number | null } {
    const r = this.db.prepare("SELECT lim, spent FROM budget WHERE run_id=?").get(this.runId) as { lim: number; spent: number } | undefined;
    return r ? { spent: r.spent, limit: r.lim < 0 ? null : r.lim } : { spent: 0, limit: null };
  }

  close(): void { try { this.db.close(); } catch { /* already closed */ } }
}
