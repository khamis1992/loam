/** Advisory packs — REMEDIATE_INTO_LOAM §6.4. Hand-written schema (16-keyword
 *  subset like the parent spec); the loader verifies each pack file's sha256
 *  against the reviewed index before anything is used (§5.9 tamper mitigation).
 *  Pack facts are vendor-corroborated (spec §2.11); bumps go through review. */

export interface PackCve {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  summary: string;
  ghsa?: string;
  cvssV4?: number;
  cvss?: string;
  cvssScore?: number;
  includedVia?: string;
}

export interface PackLine {
  line: string;
  status: "supported" | "eol" | "eol-upstream";
  fixed: string | null;
  variant?: string;
  upgradePath?: string[];
  sourceBackportsAvailable?: boolean;
  chart?: string;
}

export interface PackKnownBackport {
  distro: string;
  suite: string;
  package: string;
  release: string;
}

export interface PackMitigation {
  id: string;
  summary: string;
  isFix: false;
}

export interface AdvisoryPack {
  id: string;
  product: string;
  title: string;
  published: string;
  sourceUrls: string[];
  cves: PackCve[];
  lines: PackLine[];
  bundledUpdates?: string[];
  priorities?: string[];
  knownBackports?: PackKnownBackport[];
  sourceTarballSha256?: Record<string, string>;
  sapisAtRisk?: string[];
  mitigations?: PackMitigation[];
  forbiddenMitigations?: string[];
  forbidden: string[];
  notes?: string;
  // Electron tracker shape (§6.4.4)
  tracksAdvisory?: string;
  verifiedFixedElectronReleases?: Array<{ electron: string; bundledNode: string; evidence: string }>;
  observedAsOf?: string;
  observed?: Array<{ electron: string; bundledNode: string; vsFixed: string }>;
  scheduleHint?: string;
  policy?: string;
  // GitLab extras (§6.4.3)
  affectedFrom?: string;
  scope?: string;
  upgradePathTool?: string;
  chartMappingUrl?: string;
  imageTags?: Record<string, string>;
  postDeployChecklist?: string[];
  threatDetections?: string[];
  outOfScope?: string[];
}

export interface AdvisoryPackIndex {
  reviewedAt: string;
  packs: Array<{ id: string; file: string; sha256: string; enabled: boolean }>;
}
