/** Electron bundled-runtime detector — REMEDIATE_INTO_LOAM §6.5 (electron.ts)
 *  + the dogfood path D-7: reads the pack's `observed` table (no guessing —
 *  appendix E8); without a verified fixed release the row classifies
 *  vendor_update_required with NO proposed target. */
import type { InventoryHit } from "../types.js";
import type { ScanFile } from "./node.js";

export interface ElectronObservation {
  electron: string;
  bundledNode: string;
  vsFixed: string;
}

export function scanElectron(files: ScanFile[], lockfileContent: string | null, observed: ElectronObservation[], observedAsOf: string): InventoryHit[] {
  const hits: InventoryHit[] = [];
  for (const f of files) {
    if (f.rel !== "package.json") continue;
    try {
      const pkg = JSON.parse(f.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const range = pkg.dependencies?.["electron"] ?? pkg.devDependencies?.["electron"];
      if (!range) continue;

      // Resolve the exact version the lockfile pins (no guessing from the range).
      let exact: string | null = null;
      if (lockfileContent) {
        try {
          const lock = JSON.parse(lockfileContent) as { packages?: Record<string, { version?: string }> };
          exact = lock.packages?.["node_modules/electron"]?.version ?? null;
        } catch { /* npm-shrinkwrap or other shape — exact stays null */ }
      }

      const idx = f.content.split(/\r?\n/).findIndex((l) => l.includes('"electron"'));
      const obs = exact ? observed.find((o) => o.electron === exact) : undefined;
      hits.push({
        repoId: f.repoId, file: f.rel, line: Math.max(1, idx + 1),
        signal: `"electron": "${range}"`,
        channel: "electron",
        currentVersion: exact ?? range,
        pinStyle: "bundled",
        production: true, testCoverage: "none", confidence: exact ? "high" : "medium",
        upgradeRiskNotes: [
          obs ? `bundles Node ${obs.bundledNode} (${obs.vsFixed}) per releases.electronjs.org observed ${observedAsOf}` : "bundled Node version unknown — resolve the lockfile",
        ],
      });
    } catch { /* skip */ }
  }
  return hits;
}
