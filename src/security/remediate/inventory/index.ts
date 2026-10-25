/** Inventory orchestrator — runs the detectors over a repo's files, validates
 *  every hit against the file content (appendix E8), classifies against the
 *  enabled packs, and returns VulnRecords. Zero writes: reads only. */
import type { VulnRecord } from "../types.js";
import { loadEnabledPacks } from "../packs/loader.js";
import { scanNode, validateHits, type ScanFile } from "./node.js";
import { scanPhp } from "./php.js";
import { scanGitLab } from "./gitlab.js";
import { scanElectron } from "./electron.js";
import { classifyHit } from "./classify.js";

export interface RepoScanInput {
  repoId: string;
  /** repo-relative path -> content for the files worth scanning. */
  files: Array<{ rel: string; content: string }>;
  /** package-lock.json content when present (exact electron resolution). */
  lockfileContent?: string | null;
}

export interface InventoryResult {
  records: VulnRecord[];
  droppedHits: Array<{ repoId: string; file: string; line: number; reason: string }>;
}

const SCAN_REL = /(^|\/)(Dockerfile|dockerfile.*|\.nvmrc|\.node-version|\.tool-versions|package\.json|package-lock\.json|composer\.json|.*\.ya?ml|.*\.ansible.*|playbook.*|site\.yml|main\.yml|.*\.pp|.*\.rb)$/i;

export function runInventory(inputs: RepoScanInput[], advisoriesDir?: string): InventoryResult {
  const packs = loadEnabledPacks(advisoriesDir);
  const records: VulnRecord[] = [];
  const dropped: InventoryResult["droppedHits"] = [];

  for (const input of inputs) {
    const scanFiles: ScanFile[] = input.files
      .filter((f) => SCAN_REL.test(f.rel))
      .map((f) => ({ repoId: input.repoId, rel: f.rel, content: f.content }));
    const read = (repoId: string, rel: string): string | null =>
      input.files.find((f) => f.rel === rel)?.content ?? null;

    const raw = [
      ...scanNode(scanFiles),
      ...scanPhp(scanFiles),
      ...scanGitLab(scanFiles),
      ...scanElectron(scanFiles, input.lockfileContent ?? null,
        [...(packs.get("electron-bundled-node")?.pack.observed ?? [])],
        packs.get("electron-bundled-node")?.pack.observedAsOf ?? "unknown"),
    ];

    const { kept, dropped: d } = validateHits(raw, read);
    for (const h of d) dropped.push({ repoId: h.repoId, file: h.file, line: h.line, reason: "signal absent at file:line on re-read" });

    for (const hit of kept) {
      for (const { pack, sha256 } of packs.values()) {
        if (packMatchesHit(pack, hit)) {
          const rec = classifyHit(hit, pack, sha256);
          if (rec) records.push(rec);
          break; // one pack per hit (product-specific detectors)
        }
      }
    }
  }
  return { records, droppedHits: dropped };
}

function packMatchesHit(pack: import("../packs/schema.js").AdvisoryPack, hit: import("../types.js").InventoryHit): boolean {
  switch (pack.product) {
    case "nodejs":
      // Node owns the runtime channels EXCEPT the signals other detectors claim
      // (php/gitlab dockerfiles & packages, electron bundle). Route by signal:
      // a dockerfile/package hit belongs to Node only when it names node.
      if (hit.channel === "electron") return false;
      if (hit.channel === "dockerfile" || hit.channel === "ci_image") return /(^|\W)node(:|\W|$)/i.test(hit.signal);
      if (hit.channel === "distro_package") return /(^|\W)node/i.test(hit.signal);
      return hit.channel === "version_file" || hit.channel === "ci_setup" || hit.channel === "serverless" || hit.channel === "lockfile" || hit.channel === "helm";
    case "php": return /php/i.test(hit.signal) || hit.sapis !== undefined;
    case "gitlab-self-managed": return /gitlab/i.test(hit.signal);
    case "electron-bundled-nodejs": return hit.channel === "electron";
    default: return false;
  }
}

export { validateHits };
