/**
 * Red recon (RED_TEAM_BUILD_SPEC §6.2).
 *
 * Sn1per's graft is the *stage chaining* (recon feeds capability routing),
 * AutoPWN's graft is the vuln→exploit lead mapping — both rebuilt clean, no
 * upstream shell code. The recon stage itself reuses the gated red transport:
 * one GET per target, fingerprint from headers and title, no crawling.
 */

export interface RedReconAsset {
  target: string;
  status?: number;
  title?: string;
  server?: string;
  poweredBy?: string;
  techFingerprint: string[];
  webPaths: string[];
}

export interface CveLead {
  cveId: string;
  source: "fingerprint" | "kev";
  reason: string;
}

import type { RedCapabilityContext } from "../orchestrator/redOrchestrator.js";

/** One gated GET: status, title, server banner, technology fingerprint. */
export async function reconTarget(target: string, ctx: RedCapabilityContext): Promise<RedReconAsset> {
  const asset: RedReconAsset = { target, techFingerprint: [], webPaths: [] };
  try {
    const res = await ctx.transport.request(target);
    asset.status = res.status;
    asset.server = res.headers["server"];
    asset.poweredBy = res.headers["x-powered-by"];
    const title = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(res.body);
    if (title) asset.title = title[1]!.trim();
    const fingerprint = new Set<string>();
    if (res.headers["server"]) fingerprint.add(res.headers["server"].split("/")[0]!.toLowerCase());
    if (res.headers["x-powered-by"]) fingerprint.add(res.headers["x-powered-by"].split(/[\/ ]/)[0]!.toLowerCase());
    if (res.headers["x-aspnet-version"]) fingerprint.add("asp.net");
    if (res.headers["x-generator"]?.includes("Drupal")) fingerprint.add("drupal");
    if (res.headers["x-generator"]?.includes("WordPress")) fingerprint.add("wordpress");
    asset.techFingerprint = [...fingerprint].filter((f) => f.length > 0);
  } catch {
    // An unreachable target stays an empty asset; capabilities decide applicability.
  }
  return asset;
}

/**
 * Fingerprint → candidate CVE leads (AutoPWN graft, data level). A lead is
 * NOT a finding: it only narrows template selection for §6.6; every reported
 * claim still passes the evidence gate.
 */
const FINGERPRINT_LEADS: ReadonlyArray<{ match: string; cveId: string; reason: string }> = [
  { match: "php", cveId: "CVE-2024-4577", reason: "PHP CGI argument injection when PHP runs as CGI; verify version and SAPI" },
  { match: "wordpress", cveId: "CVE-2023-2745", reason: "WordPress core/plugin object injection family; verify version via templates" },
  { match: "drupal", cveId: "CVE-2018-7600", reason: "Drupalgeddon2 remote code execution; verify version via templates" },
  { match: "asp.net", cveId: "CVE-2017-9822", reason: "ASP.NET deserialization family; verify via deser probes" },
  { match: "apache", cveId: "CVE-2021-41773", reason: "Apache path traversal when CGI is enabled; verify version via templates" },
];

export function mapKnownVulns(asset: RedReconAsset): CveLead[] {
  const out: CveLead[] = [];
  for (const lead of FINGERPRINT_LEADS) {
    if (asset.techFingerprint.some((f) => f.includes(lead.match))) {
      out.push({ cveId: lead.cveId, source: "fingerprint", reason: `${lead.reason} (fingerprint: ${lead.match})` });
    }
  }
  return out;
}
