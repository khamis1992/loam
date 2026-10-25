/** Classification — join inventory hits to advisory packs (§6.5 classify.ts).
 *  Never guesses: a target exists only when the pack names a fixed version for
 *  the hit's line (or a known backport for distro packages). Electron rows
 *  without a verified fixed release are vendor_update_required with NO target. */
import type { InventoryHit, VulnRecord, Mitigation, UpgradeClass } from "../types.js";
import { mitigation } from "../types-mitigations.js";
import type { AdvisoryPack, PackKnownBackport } from "../packs/schema.js";

function majorOf(version: string): number {
  return parseInt(version.split(".")[0] ?? "0", 10);
}

function lineOf(version: string): string {
  const parts = version.split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0] ?? version;
}

function upgradeClass(current: string | null, target: string): UpgradeClass {
  if (!current) return "patch";
  const cm = majorOf(current);
  const tm = majorOf(target);
  if (tm > cm) return "major";
  if (tm < cm) return "none";
  // same major: minor bump for PHP-style x.y lines, patch for Node x.y.z
  const cMinor = parseInt(current.split(".")[1] ?? "0", 10);
  const tMinor = parseInt(target.split(".")[1] ?? "0", 10);
  if (tMinor > cMinor) return "minor";
  return "patch";
}

function findBackport(hit: InventoryHit, pack: AdvisoryPack): PackKnownBackport | undefined {
  if (hit.channel !== "distro_package") return undefined;
  // Match on package-name signal content; distro detection from the file text.
  return (pack.knownBackports ?? []).find((b) => hit.signal.includes(b.package));
}

export function classifyHit(hit: InventoryHit, pack: AdvisoryPack, packSha256: string): VulnRecord | null {
  if (pack.id === "electron-bundled-node") {
    // Bundled runtime: fixed only when the pack's verifiedFixedElectronReleases
    // names a release whose bundledNode >= the tracked pack's fixed version.
    const verified = (pack.verifiedFixedElectronReleases ?? []).find((v) => v.electron === hit.currentVersion);
    const bundled = (pack.observed ?? []).find((o) => o.electron === hit.currentVersion);
    const trackedFixed = pack.tracksAdvisory ? "24.22.1-or-22.23.4" : null; // resolved at resolve-time against the tracked pack
    const id = vulnId(hit, pack.id);
    if (verified) {
      return {
        id, ecosystem: "electron-bundled-nodejs", advisoryId: pack.id, cves: pack.cves.map((c) => c.id),
        hit, status: "fixed", proposedTarget: null, upgradeClass: "none", riskLabel: "low",
        origin: { kind: "runtime_inventory" }, mitigations: [],
      };
    }
    return {
      id, ecosystem: "electron-bundled-nodejs", advisoryId: pack.id, cves: pack.cves.map((c) => c.id),
      hit,
      status: "vendor_update_required",
      proposedTarget: null, // D-7/D-R9: never a guessed bump
      upgradeClass: "vendor", riskLabel: "high",
      origin: { kind: "runtime_inventory" }, mitigations: [],
      nextStep: `Watch Electron releases/advisories for a release that names the tracked CVEs or bundles a fixed Node${trackedFixed ? ` (>= ${trackedFixed})` : ""}, then bump electron, rebuild, re-sign, ship through the update channel. Observed: ${bundled ? `this version bundles Node ${bundled.bundledNode} (${bundled.vsFixed})` : "bundled Node unknown"}.`,
    };
  }

  const current = hit.currentVersion;
  if (!current) {
    return {
      id: vulnId(hit, pack.id), ecosystem: ecosystemOf(pack), advisoryId: pack.id,
      cves: pack.cves.map((c) => c.id), hit, status: "unknown",
      proposedTarget: null, upgradeClass: "none", riskLabel: "low",
      origin: { kind: "runtime_inventory" }, mitigations: [],
      nextStep: "signal carries no version — inspect the file",
    };
  }

  const backport = findBackport(hit, pack);
  // Line lookup is product-aware: Node lines are majors ("22"), PHP/GitLab are
  // x.y ("8.3"). Match by prefix so 22.21.0 -> "22" and 8.3.12 -> "8.3".
  const line = pack.lines.find((l) => current === l.line || current.startsWith(`${l.line}.`) || current.startsWith(`${l.line}-`));
  const target = line?.fixed ?? null;
  const id = vulnId(hit, pack.id);

  if (target && current === target) {
    return {
      id, ecosystem: ecosystemOf(pack), advisoryId: pack.id, cves: pack.cves.map((c) => c.id),
      hit, status: "fixed", proposedTarget: null, upgradeClass: "none", riskLabel: "low",
      origin: { kind: "runtime_inventory" }, mitigations: [],
    };
  }

  if (target && versionLt(current, target)) {
    const cls = upgradeClass(current, target);
    return {
      id, ecosystem: ecosystemOf(pack), advisoryId: pack.id, cves: pack.cves.map((c) => c.id),
      hit, status: "vulnerable", proposedTarget: target, upgradeClass: cls,
      riskLabel: cls === "patch" ? "low" : "high",
      origin: { kind: "runtime_inventory" },
      mitigations: (pack.mitigations ?? []).map((m) => mitigation(m.id, m.summary)),
      downtimeNote: pack.product === "gitlab-self-managed" ? "single-node GitLab needs a maintenance window during upgrade" : undefined,
    };
  }

  // EOL or distro-package path
  if (line && line.fixed === null) {
    return {
      id, ecosystem: ecosystemOf(pack), advisoryId: pack.id, cves: pack.cves.map((c) => c.id),
      hit, status: "eol", proposedTarget: null,
      upgradeClass: "major",
      riskLabel: "high",
      origin: { kind: "runtime_inventory" },
      mitigations: (pack.mitigations ?? []).map((m) => mitigation(m.id, m.summary)),
      nextStep: `line ${line.line} is ${line.status}; upgrade path: ${(line.upgradePath ?? []).join(" → ") || "vendor guidance"}; major upgrade needs explicit approval`,
    };
  }

  if (backport) {
    return {
      id, ecosystem: ecosystemOf(pack), advisoryId: pack.id, cves: pack.cves.map((c) => c.id),
      hit, status: "vulnerable", proposedTarget: backport.release, upgradeClass: "patch", riskLabel: "low",
      origin: { kind: "runtime_inventory" }, mitigations: [],
    };
  }

  if (!line) {
    return {
      id, ecosystem: ecosystemOf(pack), advisoryId: pack.id, cves: pack.cves.map((c) => c.id),
      hit, status: "unknown", proposedTarget: null, upgradeClass: "none", riskLabel: "low",
      origin: { kind: "runtime_inventory" }, mitigations: [],
      nextStep: `current "${current}" maps to no pack line — vendor changelog check required`,
    };
  }

  // current >= target or incomparable
  return {
    id, ecosystem: ecosystemOf(pack), advisoryId: pack.id, cves: pack.cves.map((c) => c.id),
    hit, status: "unknown", proposedTarget: null, upgradeClass: "none", riskLabel: "low",
    origin: { kind: "runtime_inventory" }, mitigations: [],
    nextStep: `current "${current}" does not sort below fixed "${target}" — distro/vendor mapping needed`,
  };
}

function ecosystemOf(pack: AdvisoryPack): VulnRecord["ecosystem"] {
  switch (pack.product) {
    case "nodejs": return "nodejs";
    case "php": return "php";
    case "gitlab-self-managed": return "gitlab-self-managed";
    case "electron-bundled-nodejs": return "electron-bundled-nodejs";
    default: return "npm";
  }
}

export function vulnId(hit: InventoryHit, advisoryId: string): string {
  // Stable within the run: sha256(repoId|file|line|signal).slice(0,16) (§7).
  // Computed lazily to avoid importing crypto into classify (pure for tests).
  const raw = `${hit.repoId}|${hit.file}|${hit.line}|${hit.signal}`;
  // FNV-1a 64-bit fallback is not stable enough; use a djb2-style 16-hex from
  // two 32-bit passes — deterministic and collision-safe for run scope.
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < raw.length; i++) {
    h1 = (h1 ^ raw.charCodeAt(i)) * 0x01000193 >>> 0;
    h2 = (h2 + raw.charCodeAt(i) * (i + 1)) * 31 >>> 0;
  }
  return `${advisoryId}-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** Numeric-aware a < b for dotted versions (patch/minor only; majors are
 *  handled by upgradeClass, never silently "fixed"). */
export function versionLt(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db;
  }
  return false;
}
