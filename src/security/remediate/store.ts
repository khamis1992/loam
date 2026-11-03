/** Run store — REMEDIATE_INTO_LOAM §7.2. Parent-only writer of run.json; the
 *  store lives under <DATA_DIR>/security-remediations/<runId>/. Writes are
 *  durable (tmp+rename) and the run document is written BEFORE every state
 *  transition (§7.3). */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../config.js";
import type { RemediationRun, VulnRecord, RemediationEvidence } from "./types.js";

export function remediationsRoot(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, "security-remediations");
}

export function runDir(runId: string, dataDir: string = DATA_DIR): string {
  return path.join(remediationsRoot(dataDir), runId);
}

function durableWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

export function writeRun(run: RemediationRun, dataDir: string = DATA_DIR): void {
  durableWrite(path.join(runDir(run.id, dataDir), "run.json"), JSON.stringify(run, null, 1) + "\n");
}

export function readRun(runId: string, dataDir: string = DATA_DIR): RemediationRun | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir(runId, dataDir), "run.json"), "utf8")) as RemediationRun;
  } catch {
    return null;
  }
}

export function listRuns(dataDir: string = DATA_DIR): RemediationRun[] {
  try {
    return fs.readdirSync(remediationsRoot(dataDir))
      .filter((d) => fs.existsSync(path.join(remediationsRoot(dataDir), d, "run.json")))
      .map((d) => readRun(d, dataDir))
      .filter((r): r is RemediationRun => r !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export function writeInventory(runId: string, inventory: VulnRecord[], dataDir: string = DATA_DIR): void {
  durableWrite(path.join(runDir(runId, dataDir), "inventory.json"), JSON.stringify(inventory, null, 1) + "\n");
}

export function appendEvidence(runId: string, evidence: RemediationEvidence, dataDir: string = DATA_DIR): void {
  const dir = path.join(runDir(runId, dataDir), "evidence");
  durableWrite(path.join(dir, `${evidence.id}.json`), JSON.stringify(evidence, null, 1) + "\n");
}

/** Copy the packs used by a run into its store (pinned by hash — §7.2). */
export function snapshotPacks(runId: string, packs: Array<{ id: string; file: string }>, dataDir: string = DATA_DIR): void {
  const dest = path.join(runDir(runId, dataDir), "packs");
  fs.mkdirSync(dest, { recursive: true });
  for (const p of packs) {
    fs.copyFileSync(p.file, path.join(dest, `${p.id}.json`));
  }
}

/** Paths for the per-repo plan artifacts (§7.2 layout). */
export function planPaths(runId: string, repoId: string, dataDir: string = DATA_DIR) {
  const base = path.join(runDir(runId, dataDir), "plans", repoId);
  return {
    base,
    proposal: path.join(base, "proposal.json"),
    diff: path.join(base, "diff.patch"),
    prBody: path.join(base, "PR_BODY.md"),
    commit: path.join(base, "commit.json"),
    pr: path.join(base, "pr.json"),
    baselineDir: path.join(base, "baseline"),
    afterDir: path.join(base, "after"),
    worktreesDir: path.join(runDir(runId, dataDir), "worktrees"),
    reposDir: path.join(runDir(runId, dataDir), "repos"),
  };
}
