// src/skills/install.ts — (MISSING §6.6 reference implementation, tested on the box)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, SKILLS_DIR } from "../config.js";
import { scanSkillDir } from "./scan/scanner.js";
import { upsertLock } from "./lock.js";
import type { ScanReport } from "./scan/types.js";

export class SkillScanBlocked extends Error {
  readonly report: ScanReport;
  readonly skill: string;
  constructor(report: ScanReport, skill: string) {
    super(`skill "${skill}" blocked by the security scan (${report.stats.critical} critical, ${report.stats.high} high)`);
    this.report = report;
    this.skill = skill;
  }
}

export interface RemoteSkillFile { rel: string; url: string; }
export interface StagedInstallInput {
  name: string;                               // target folder under SKILLS_DIR (already slug-validated)
  files: RemoteSkillFile[];
  source: { kind: "catalog" | "github"; repo: string; path: string; ref: string; commit: string | null };
  force?: boolean;
  acceptRisk?: boolean;                       // only the HTTP route may set this, after the user confirms in the UI
  fetchText: (url: string) => Promise<string>;
}
export interface StagedInstallResult { name: string; dir: string; files: string[]; report: ScanReport; }

const STAGING = () => path.join(DATA_DIR, "skill-staging");

function inside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Download → stage → scan → (block | atomic swap) → lock. Nothing reaches SKILLS_DIR before the scan passes. */
export async function stagedInstall(inp: StagedInstallInput): Promise<StagedInstallResult> {
  const finalDir = path.join(SKILLS_DIR, inp.name);
  if (!inside(SKILLS_DIR, finalDir)) throw new Error("invalid skill name");
  if (fs.existsSync(path.join(finalDir, "SKILL.md")) && inp.force !== true) throw new Error(`skill "${inp.name}" already exists (pass force=true to overwrite)`);
  const stage = path.join(STAGING(), crypto.randomUUID());
  fs.mkdirSync(stage, { recursive: true });
  try {
    const written: string[] = [];
    for (const f of inp.files) {
      const rel = f.rel.split("\\").join("/");
      if (!rel || rel.split("/").includes("..")) continue;
      const abs = path.join(stage, rel);
      if (!inside(stage, abs)) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, await inp.fetchText(f.url), "utf8");
      written.push(rel);
    }
    if (!written.includes("SKILL.md")) throw new Error("SKILL.md was not downloaded");
    const report = scanSkillDir(stage);
    if (report.verdict === "fail" && inp.acceptRisk !== true) throw new SkillScanBlocked(report, inp.name);
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    const backup = fs.existsSync(finalDir) ? `${finalDir}.bak-${Date.now()}` : null;
    if (backup) fs.renameSync(finalDir, backup);
    try { fs.renameSync(stage, finalDir); }
    catch (e) { if (backup) fs.renameSync(backup, finalDir); throw e; }
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
    upsertLock({ name: inp.name, source: inp.source, installedAt: new Date().toISOString(), contentHash: report.contentHash, files: written.sort(),
      scan: { rulesetVersion: report.rulesetVersion, verdict: report.verdict, stats: report.stats, acceptedRisk: report.verdict === "fail" } });
    return { name: inp.name, dir: finalDir, files: written, report };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** Resolve a branch/tag to a commit so every file comes from one snapshot. */
export async function resolveCommit(owner: string, repo: string, ref: string, headers: Record<string, string>): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
      { headers: { ...headers, accept: "application/vnd.github.sha" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    const sha = (await res.text()).trim();
    return res.ok && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch { return null; }
}
