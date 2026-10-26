// src/appbuilder/versions.ts
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import type { AppProject, AppVersion, VersionFileChange, VersionSource, VersionUsage } from "./types.js";

const exec = promisify(execFile);

export const DB_SNAPSHOT_KEEP = 20;
export const DB_SNAPSHOT_MAX_BYTES = 200 * 1024 * 1024;
export const MAX_DIFF_BYTES = 200 * 1024;

const EXCLUDE = [
  "# Loam App Builder version store. Only app/ and .loam/context/ are versioned.",
  "/*", "!/app/", "!/.loam/", "/.loam/*", "!/.loam/context/",
  "/app/node_modules/", "/app/dist/", "/app/.vite-cache/",
  "/app/data/*.sqlite", "/app/data/*.sqlite-*", "/app/.env", "/app/.env.*", "*.log", "",
].join("\n");

const CONFIG: Array<[string, string]> = [
  ["core.autocrlf", "false"], ["core.safecrlf", "false"], ["core.longpaths", "true"],
  ["core.quotepath", "false"], ["core.fsmonitor", "false"], ["gc.auto", "0"],
  ["user.name", "Loam"], ["user.email", "versions@loam.local"],
];

export interface VersionStoreRow {
  insertVersion(v: AppVersion & { dbSnapshot: string | null }): void;
  latestVersion(projectId: string): (AppVersion & { dbSnapshot: string | null }) | null;
  getVersion(projectId: string, n: number): (AppVersion & { dbSnapshot: string | null }) | null;
  clearDbSnapshot(projectId: string, n: number): void;
}

export class VersionService {
  constructor(private rows: VersionStoreRow) {}

  private gitDir(p: AppProject): string { return path.join(p.workspaceDir, ".loam", "versions.git"); }

  async git(p: AppProject, args: string[], opts: { input?: string; maxBuffer?: number } = {}): Promise<string> {
    const { stdout } = await exec("git", ["--git-dir", this.gitDir(p), "--work-tree", p.workspaceDir, ...args], {
      cwd: p.workspaceDir,
      windowsHide: true,
      maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  }

  /** Idempotent. Safe to call on every project open. */
  async init(p: AppProject): Promise<void> {
    const dir = this.gitDir(p);
    if (!fs.existsSync(path.join(dir, "HEAD"))) {
      fs.mkdirSync(dir, { recursive: true });
      await exec("git", ["init", "--bare", "--initial-branch=versions", dir], { windowsHide: true });
      // A bare repo plus --work-tree on every call gives us a normal index without a .git in the workspace.
      await exec("git", ["--git-dir", dir, "config", "core.bare", "false"], { windowsHide: true });
    }
    for (const [k, v] of CONFIG) await exec("git", ["--git-dir", dir, "config", k, v], { windowsHide: true });
    fs.mkdirSync(path.join(dir, "info"), { recursive: true });
    fs.writeFileSync(path.join(dir, "info", "exclude"), EXCLUDE, "utf8");
  }

  async isDirty(p: AppProject): Promise<boolean> {
    return (await this.git(p, ["status", "--porcelain", "--untracked-files=all"])).trim().length > 0;
  }

  private async headCommit(p: AppProject): Promise<string | null> {
    try { return (await this.git(p, ["rev-parse", "--verify", "HEAD"])).trim(); } catch { return null; }
  }

  private async changes(p: AppProject, parent: string | null, commit: string): Promise<VersionFileChange[]> {
    const args = parent
      ? ["diff-tree", "--no-commit-id", "--name-status", "-r", "--no-renames", parent, commit]
      : ["diff-tree", "--no-commit-id", "--name-status", "-r", "--no-renames", "--root", commit];
    const out = await this.git(p, args);
    return out.split("\n").filter(Boolean).map((line) => {
      const [code, ...rest] = line.split("\t");
      const c = code?.[0] ?? "M";
      return { path: rest.join("\t"), change: (c === "A" ? "A" : c === "D" ? "D" : "M") as VersionFileChange["change"] };
    });
  }

  /**
   * Commit the work tree as a new version. Returns null when nothing changed.
   * The caller supplies title and summary (from VERSION_TITLE_SYSTEM, §4.7.3 naming).
   */
  async snapshot(p: AppProject, o: { title: string; summary: string; source: VersionSource; parentNumber?: number | null; verifyReportId?: string | null; usage: VersionUsage; addedPackages?: AppVersion["addedPackages"] }): Promise<AppVersion | null> {
    await this.init(p);
    await this.git(p, ["add", "-A"]);
    const parent = await this.headCommit(p);
    const staged = parent
      ? (await this.git(p, ["diff", "--cached", "--name-only"])).trim()
      : (await this.git(p, ["ls-files"])).trim();
    if (!staged && o.source !== "restore") return null;

    const prev = this.rows.latestVersion(p.id);
    const number = (prev?.number ?? 0) + 1;
    await this.git(p, ["commit", "--allow-empty", "--no-verify", "-q", "-m", `v${number}: ${o.title}`, "-m", o.summary]);
    const commit = (await this.git(p, ["rev-parse", "HEAD"])).trim();
    await this.git(p, ["tag", `v${number}`, commit]);

    const version: AppVersion = {
      projectId: p.id,
      number,
      title: o.title.slice(0, 60),
      summary: o.summary.slice(0, 600),
      commit,
      parentNumber: o.parentNumber === undefined ? prev?.number ?? null : o.parentNumber,
      source: o.source,
      filesChanged: await this.changes(p, parent, commit),
      verifyReportId: o.verifyReportId ?? null,
      usage: o.usage,
      addedPackages: o.addedPackages ?? [],
      createdAt: new Date().toISOString(),
    };
    const dbSnapshot = this.snapshotDatabase(p, number);
    this.rows.insertVersion({ ...version, dbSnapshot });
    return version;
  }

  private snapshotDatabase(p: AppProject, number: number): string | null {
    const live = path.join(p.workspaceDir, "app", "data", "app.sqlite");
    if (!p.features.includes("fullstack") || !fs.existsSync(live)) return null;
    const dir = path.join(p.workspaceDir, ".loam", "db-snapshots");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `v${number}.sqlite`);
    if (fs.existsSync(target)) fs.rmSync(target);
    const db = new DatabaseSync(live, { readOnly: true });
    try { db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); } finally { db.close(); }
    this.pruneDbSnapshots(p, dir);
    return path.relative(p.workspaceDir, target).split(path.sep).join("/");
  }

  private pruneDbSnapshots(p: AppProject, dir: string): void {
    const files = fs.readdirSync(dir)
      .filter((f) => /^v\d+\.sqlite$/.test(f))
      .map((f) => ({ f, n: Number(f.slice(1, -7)), size: fs.statSync(path.join(dir, f)).size }))
      .sort((a, b) => b.n - a.n);
    let total = 0;
    files.forEach((x, i) => {
      total += x.size;
      if (i >= DB_SNAPSHOT_KEEP || total > DB_SNAPSHOT_MAX_BYTES) {
        fs.rmSync(path.join(dir, x.f));
        this.rows.clearDbSnapshot(p.id, x.n);
      }
    });
  }

  /** Unified diff between two versions, optionally for one path. Capped at 200 KB. */
  async diff(p: AppProject, from: number, to: number, file?: string): Promise<{ text: string; truncated: boolean }> {
    const a = this.rows.getVersion(p.id, from); const b = this.rows.getVersion(p.id, to);
    if (!a || !b) throw new Error("version_not_found");
    const out = await this.git(p, ["diff", "--no-color", "--no-ext-diff", a.commit, b.commit, ...(file ? ["--", file] : [])]);
    return out.length > MAX_DIFF_BYTES ? { text: out.slice(0, MAX_DIFF_BYTES), truncated: true } : { text: out, truncated: false };
  }

  /** Read one file as it was in a version. */
  async readFileAt(p: AppProject, n: number, file: string): Promise<string> {
    const v = this.rows.getVersion(p.id, n);
    if (!v) throw new Error("version_not_found");
    return this.git(p, ["show", `${v.commit}:${file}`]);
  }

  /**
   * Restore version n. Never discards work: unsaved changes are saved as their own version first.
   * The result is a NEW version "Restored from vN" whose files equal vN byte for byte.
   */
  async restore(p: AppProject, n: number, o: { skipDbRestore: boolean; message?: string; stopAppServer: () => Promise<void> }): Promise<AppVersion> {
    const target = this.rows.getVersion(p.id, n);
    if (!target) throw new Error("version_not_found");
    if (await this.isDirty(p)) {
      await this.snapshot(p, { title: "Unsaved changes", summary: `Saved automatically before restoring v${n}.`, source: "edit", usage: zeroUsage() });
    }
    await this.git(p, ["read-tree", "--reset", "-u", target.commit]);
    if (!o.skipDbRestore && target.dbSnapshot) {
      await o.stopAppServer();
      const live = path.join(p.workspaceDir, "app", "data", "app.sqlite");
      fs.mkdirSync(path.dirname(live), { recursive: true });
      for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(live + suffix)) fs.rmSync(live + suffix);
      fs.copyFileSync(path.join(p.workspaceDir, target.dbSnapshot), live);
    }
    const v = await this.snapshot(p, {
      title: `Restored from v${n}`,
      summary: o.message?.trim() || `Files restored from v${n}${o.skipDbRestore || !target.dbSnapshot ? "; database kept as it was" : " with its database"}.`,
      source: "restore",
      parentNumber: n,
      usage: zeroUsage(),
    });
    if (!v) throw new Error("restore_produced_no_version");
    return v;
  }

  /** Commit-only view used by race and parallel assignments (§4.7.4, §4.13). */
  async addScratchTree(p: AppProject, name: string, fromCommit: string): Promise<string> {
    const dir = path.join(p.workspaceDir, ".loam", "scratch", name);
    await this.git(p, ["worktree", "add", "--detach", "--force", dir, fromCommit]);
    return dir;
  }

  async removeScratchTree(p: AppProject, dir: string): Promise<void> {
    await this.git(p, ["worktree", "remove", "--force", dir]).catch(() => undefined);
    await this.git(p, ["worktree", "prune"]).catch(() => undefined);
  }
}

export function zeroUsage(): VersionUsage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, credits: 0, wallMs: 0, toolCalls: 0 };
}
