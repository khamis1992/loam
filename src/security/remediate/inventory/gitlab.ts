/** GitLab self-managed inventory detector — REMEDIATE_INTO_LOAM §6.5 (gitlab.ts). */
import type { InventoryHit } from "../types.js";
import type { ScanFile } from "./node.js";

const GITLAB_IMAGE = /(?:gitlab\/gitlab-(ee|ce):(\S+)|registry\.gitlab\.com\/gitlab-org\/build\/cng\/\S+)/i;
const OMNIBUS_PKG = /gitlab-(ee|ce)[=~<>]?\s*([\d.]+(?:-[ec]e\.\d+)?)/i;
const HELM_GITLAB = /charts\.gitlab\.com\/gitlab|gitlab\.gitlab\.com/i;

function glHit(repoId: string, rel: string, lineIdx: number, signal: string, extra: Partial<InventoryHit>): InventoryHit {
  return {
    repoId, file: rel, line: lineIdx + 1, signal,
    channel: "dockerfile", currentVersion: null, pinStyle: "exact",
    production: true, testCoverage: "none", confidence: "high",
    upgradeRiskNotes: [], topology: "unknown",
    ...extra,
  };
}

export function scanGitLab(files: ScanFile[]): InventoryHit[] {
  const hits: InventoryHit[] = [];
  for (const f of files) {
    const lines = f.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      const img = line.match(GITLAB_IMAGE);
      if (img && (/dockerfile/i.test(f.rel) || /values\.ya?ml|deploy/i.test(f.rel))) {
        const edition = (img[1] as "ee" | "ce" | undefined) ?? (/cng/i.test(line) ? undefined : undefined);
        const ver = img[2]?.split("-")[0]?.replace(/-ee\.0$|-ce\.0$/, "") ?? null;
        hits.push(glHit(f.repoId, f.rel, i, line.trim(), {
          channel: /ya?ml/i.test(f.rel) ? "helm" : "dockerfile",
          currentVersion: ver,
          pinStyle: /chart/i.test(f.rel) ? "iac" : line.includes("@sha256:") ? "digest" : /^\d+\.\d+\.\d+/.test(img[2] ?? "") ? "exact" : "floating",
          edition: edition === "ee" || edition === "ce" ? edition : undefined,
        }));
        continue;
      }

      const omnibus = line.match(OMNIBUS_PKG);
      if (omnibus && /ansible|chef|puppet|cloud-init|packer|playbook/i.test(f.rel)) {
        hits.push(glHit(f.repoId, f.rel, i, line.trim(), {
          channel: "ansible", currentVersion: omnibus[2] ?? null, pinStyle: "package",
          edition: omnibus[1] === "ee" || omnibus[1] === "ce" ? (omnibus[1] as "ee" | "ce") : undefined,
        }));
        continue;
      }

      if (HELM_GITLAB.test(line)) {
        hits.push(glHit(f.repoId, f.rel, i, line.trim(), { channel: "helm", currentVersion: null, pinStyle: "iac", confidence: "medium" }));
      }
    }
  }
  return hits;
}
