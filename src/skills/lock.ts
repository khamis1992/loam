// src/skills/lock.ts — (MISSING §6.6 reference implementation, tested on the box)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import type { ScanReport } from "./scan/types.js";

/** DATA_DIR/skills.lock.json — provenance + integrity for every installed (non-authored) skill. */
export interface SkillLockEntry {
  name: string;                          // folder name under SKILLS_DIR
  source: { kind: "catalog" | "github"; repo: string; path: string; ref: string; commit: string | null };
  installedAt: string;
  contentHash: string;                   // ScanReport.contentHash at install time
  files: string[];
  scan: { rulesetVersion: string; verdict: ScanReport["verdict"]; stats: ScanReport["stats"]; acceptedRisk: boolean };
}
export interface SkillLock { version: 1; skills: Record<string, SkillLockEntry>; }

const LOCK_FILE = () => path.join(DATA_DIR, "skills.lock.json");

export function readLock(): SkillLock {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK_FILE(), "utf8")) as SkillLock;
    if (raw && raw.version === 1 && raw.skills && typeof raw.skills === "object") return raw;
  } catch { /* missing or corrupt: start fresh */ }
  return { version: 1, skills: {} };
}

export function writeLock(lock: SkillLock): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${LOCK_FILE()}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, LOCK_FILE());
}

export function upsertLock(entry: SkillLockEntry): void { const l = readLock(); l.skills[entry.name] = entry; writeLock(l); }
export function removeLock(name: string): void { const l = readLock(); if (l.skills[name]) { delete l.skills[name]; writeLock(l); } }

/** "modified" when the folder's current content hash differs from the locked one (local edits or tampering). */
export function lockStatus(name: string, currentHash: string): "untracked" | "clean" | "modified" {
  const e = readLock().skills[name];
  return !e ? "untracked" : e.contentHash === currentHash ? "clean" : "modified";
}
