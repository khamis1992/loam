/** Node runtime inventory detector — REMEDIATE_INTO_LOAM §6.5 (node.ts).
 *  Signals from fix-node-vuln SKILL :22-29. Pure filesystem; every returned
 *  hit carries the exact signal text so `validateHits` can re-verify. */
import type { InventoryHit } from "../types.js";

export interface ScanFile {
  repoId: string;
  rel: string;
  content: string;
}

const FROM_NODE = /^\s*FROM\s+(\S*\/)?node:(\S+)\s*(AS\s+\S+)?\s*$/i;

function hit(repoId: string, rel: string, lineIdx: number, signal: string, extra: Partial<InventoryHit>): InventoryHit {
  return {
    repoId, file: rel, line: lineIdx + 1, signal,
    channel: "dockerfile", currentVersion: null, pinStyle: "exact",
    production: true, testCoverage: "unknown" as never === "x" ? "none" : "none", confidence: "high",
    upgradeRiskNotes: [],
    ...extra,
  };
}

export function scanNode(files: ScanFile[]): InventoryHit[] {
  const hits: InventoryHit[] = [];
  for (const f of files) {
    const lines = f.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Dockerfile FROM node:<tag> (multi-stage included)
      const from = line.match(FROM_NODE);
      if (from && (/dockerfile/i.test(f.rel) || f.rel === "Dockerfile")) {
        const tag = from[2]!;
        const digest = tag.includes("@sha256:");
        const floating = !digest && !/^\d+\.\d+\.\d+/.test(tag);
        hits.push(hit(f.repoId, f.rel, i, line.trim(), {
          channel: "dockerfile",
          currentVersion: digest ? tag.split("@")[0]! : tag.split("-")[0]!,
          pinStyle: digest ? "digest" : floating ? "floating" : "exact",
          upgradeRiskNotes: [],
        }));
        continue;
      }

      // .nvmrc / .node-version — whole-file version
      if (f.rel === ".nvmrc" || f.rel === ".node-version") {
        const v = line.trim().replace(/^v/, "");
        if (v && i === 0) {
          hits.push(hit(f.repoId, f.rel, i, v, { channel: "version_file", currentVersion: v, pinStyle: "exact" }));
        }
        continue;
      }

      // .tool-versions nodejs <ver>
      const tv = line.match(/^nodejs\s+(\S+)/);
      if (tv && f.rel === ".tool-versions") {
        hits.push(hit(f.repoId, f.rel, i, line.trim(), { channel: "version_file", currentVersion: tv[1]!, pinStyle: "exact" }));
        continue;
      }

      // CI setup-node
      const nv = line.match(/node-version:\s*(?:'([^']+)'|"([^"]+)"|(\S+))/);
      if (nv && /\.ya?ml$/.test(f.rel) && /setup-node|\.github\/workflows/i.test(f.rel)) {
        const raw = nv[1] ?? nv[2] ?? nv[3] ?? "";
        const isFileRef = /nvmrc|\.node-version|\.tool-versions/i.test(raw);
        hits.push(hit(f.repoId, f.rel, i, line.trim(), {
          channel: "ci_setup",
          currentVersion: isFileRef ? null : raw,
          pinStyle: isFileRef || !/^\d+\.\d+\.\d+$/.test(raw) ? "floating" : "exact",
          production: false,
        }));
        continue;
      }

      // Serverless runtime
      const sls = line.match(/Runtime:\s*nodejs(\d+)\.x/i);
      if (sls) {
        hits.push(hit(f.repoId, f.rel, i, line.trim(), { channel: "serverless", currentVersion: sls[1]!, pinStyle: "managed" }));
        continue;
      }
    }

    // package.json — volta.node + engines.node (constraint signal only) + electron handled by its own detector
    if (f.rel === "package.json") {
      try {
        const pkg = JSON.parse(f.content) as { volta?: { node?: string }; engines?: { node?: string } };
        if (pkg.volta?.node) {
          const idx = f.content.split(/\r?\n/).findIndex((l) => /"node"\s*:/.test(l) && /volta/i.test(f.content.slice(0, f.content.indexOf(l))));
          hits.push(hit(f.repoId, f.rel, Math.max(0, idx), `"node": "${pkg.volta.node}"`, { channel: "version_file", currentVersion: pkg.volta.node, pinStyle: "exact" }));
        }
        if (pkg.engines?.node) {
          const idx = f.content.split(/\r?\n/).findIndex((l) => l.includes('"node"') && f.content.indexOf('"engines"') < f.content.indexOf(l));
          if (idx >= 0) {
            hits.push(hit(f.repoId, f.rel, idx, `"node": "${pkg.engines.node}"`, {
              channel: "lockfile", currentVersion: null, pinStyle: "constraint", production: false, confidence: "low",
              upgradeRiskNotes: ["engines.node is a constraint, not a runtime pin — signal only, never edited"],
            }));
          }
        }
      } catch { /* malformed package.json — skip */ }
    }
  }
  return hits;
}

/** Re-read file:line and keep only hits whose claimed signal is still present
 *  (appendix E8 — the machine answer to inventory hallucination). */
export function validateHits(hits: InventoryHit[], read: (repoId: string, rel: string) => string | null): { kept: InventoryHit[]; dropped: InventoryHit[] } {
  const kept: InventoryHit[] = [];
  const dropped: InventoryHit[] = [];
  for (const h of hits) {
    const content = read(h.repoId, h.file);
    const line = content?.split(/\r?\n/)[h.line - 1];
    if (line && line.includes(h.signal.trim().replace(/^"|"$/g, "").split('"')[0]!.slice(0, 24))) kept.push(h);
    else dropped.push(h);
  }
  return { kept, dropped };
}
