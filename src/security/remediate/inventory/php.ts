/** PHP runtime inventory detector — REMEDIATE_INTO_LOAM §6.5 (php.ts). */
import type { InventoryHit } from "../types.js";
import type { ScanFile } from "./node.js";

const FROM_PHP = /^\s*FROM\s+(\S*\/)?php:(\S+)\s*(AS\s+\S+)?\s*$/i;
const PHP_PKG = /^\s*(apt-get\s+install|apk\s+add|dnf\s+install|yum\s+install).*\bphp[\d.]*[=<>]/i;

function phpHit(repoId: string, rel: string, lineIdx: number, signal: string, extra: Partial<InventoryHit>): InventoryHit {
  return {
    repoId, file: rel, line: lineIdx + 1, signal,
    channel: "dockerfile", currentVersion: null, pinStyle: "exact",
    production: true, testCoverage: "none", confidence: "high",
    upgradeRiskNotes: [], sapis: [],
    ...extra,
  };
}

export function scanPhp(files: ScanFile[]): InventoryHit[] {
  const hits: InventoryHit[] = [];
  for (const f of files) {
    const lines = f.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      const from = line.match(FROM_PHP);
      if (from && (/dockerfile/i.test(f.rel) || f.rel === "Dockerfile")) {
        const tag = from[2]!;
        const sapi = /-fpm/.test(tag) ? "fpm" : /-apache/.test(tag) ? "apache" : /-cli|-alpine/.test(tag) ? "cli" : "unknown";
        hits.push(phpHit(f.repoId, f.rel, i, line.trim(), {
          currentVersion: tag.split("-")[0]!,
          pinStyle: tag.includes("@sha256:") ? "digest" : /^\d+\.\d+\.\d+/.test(tag) ? "exact" : "floating",
          sapis: [sapi],
        }));
        continue;
      }

      if (PHP_PKG.test(line)) {
        const pkg = line.match(/php[\d.]*/)?.[0] ?? "php";
        hits.push(phpHit(f.repoId, f.rel, i, line.trim(), { channel: "distro_package", currentVersion: pkg, pinStyle: "package" }));
        continue;
      }

      const setupPhp = line.match(/(?:uses:\s+.*setup-php|php-version:\s*(\S+))/i);
      if (setupPhp && /\.ya?ml$/.test(f.rel)) {
        hits.push(phpHit(f.repoId, f.rel, i, line.trim(), {
          channel: "ci_setup", currentVersion: setupPhp[1] ?? null, pinStyle: "floating", production: false,
        }));
        continue;
      }
    }

    if (f.rel === "composer.json") {
      try {
        const pkg = JSON.parse(f.content) as { require?: Record<string, string> };
        const phpReq = pkg.require?.["php"];
        if (phpReq) {
          const idx = f.content.split(/\r?\n/).findIndex((l) => l.includes('"php"'));
          if (idx >= 0) {
            hits.push(phpHit(f.repoId, f.rel, idx, `"php": "${phpReq}"`, {
              channel: "lockfile", currentVersion: null, pinStyle: "constraint", production: false, confidence: "low",
              upgradeRiskNotes: ["composer require.php is a constraint — leave unless it would exclude the fixed version"],
            }));
          }
        }
      } catch { /* skip */ }
    }
  }
  return hits;
}
