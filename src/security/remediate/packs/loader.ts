/** Pack loader — hash-gated against the reviewed index (§6.4.5, appendix E8).
 *  A tampered pack is refused with `pack_hash_mismatch` before any row is
 *  classified; disabled packs are skipped. Pure filesystem, no network. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RemediationError } from "../errors.js";
import type { AdvisoryPack, AdvisoryPackIndex } from "./schema.js";

export function advisoriesDir(): string {
  // Repo-relative data (packs ship inside the app; §6.1/E9).
  return path.resolve(import.meta.dirname ?? ".", "../../../../..", "security", "advisories");
}

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export interface LoadedPack {
  pack: AdvisoryPack;
  sha256: string;
}

/** Load every ENABLED pack, verifying each file's hash against the index. */
export function loadEnabledPacks(dir: string = advisoriesDir()): Map<string, LoadedPack> {
  const indexPath = path.join(dir, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as AdvisoryPackIndex;
  const out = new Map<string, LoadedPack>();
  for (const entry of index.packs) {
    if (!entry.enabled) continue;
    const file = path.join(dir, entry.file);
    const actual = sha256(file);
    if (actual !== entry.sha256) {
      throw new RemediationError(500, "pack_hash_mismatch", `${entry.id}: expected ${entry.sha256.slice(0, 12)}…, found ${actual.slice(0, 12)}…`);
    }
    const pack = JSON.parse(fs.readFileSync(file, "utf8")) as AdvisoryPack;
    validatePackShape(pack);
    out.set(pack.id, { pack, sha256: actual });
  }
  return out;
}

/** Load one pack by id (enabled or not — rescan needs both). Hash still verified. */
export function loadPack(id: string, dir: string = advisoriesDir()): LoadedPack {
  const indexPath = path.join(dir, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as AdvisoryPackIndex;
  const entry = index.packs.find((p) => p.id === id);
  if (!entry) throw new RemediationError(404, "run_not_found", `unknown advisory pack: ${id}`);
  const file = path.join(dir, entry.file);
  const actual = sha256(file);
  if (actual !== entry.sha256) {
    throw new RemediationError(500, "pack_hash_mismatch", `${entry.id}: index hash mismatch`);
  }
  const pack = JSON.parse(fs.readFileSync(file, "utf8")) as AdvisoryPack;
  validatePackShape(pack);
  return { pack, sha256: actual };
}

/** Minimal structural validation (the 16-keyword-subset discipline). */
export function validatePackShape(pack: AdvisoryPack): void {
  const fail = (why: string) => new RemediationError(400, "invalid_input", `pack ${pack.id ?? "(?)"}: ${why}`);
  if (typeof pack.id !== "string" || !pack.id) throw fail("missing id");
  if (!Array.isArray(pack.sourceUrls) || pack.sourceUrls.length === 0) throw fail("no sourceUrls");
  if (!Array.isArray(pack.cves) || pack.cves.length === 0) throw fail("no cves");
  if (!Array.isArray(pack.lines) && !Array.isArray(pack.observed)) throw fail("no lines and no observed (electron tracker needs one)");
  // Every fixed version must carry at least one source URL (§6.4.5 CI rule).
  for (const line of pack.lines ?? []) {
    if (line.fixed != null && pack.sourceUrls.length === 0) throw fail(`line ${line.line} fixed without sourceUrls`);
  }
  for (const m of pack.mitigations ?? []) {
    if (m.isFix !== false) throw fail(`mitigation ${m.id} must have isFix:false`);
  }
}

/** Re-hash a pack file (used when authoring a bump + by the pack test). */
export function hashPackFile(file: string): string {
  return sha256(file);
}
