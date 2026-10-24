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
    if (res.headers["x-generator"]?.includes("Joomla")) fingerprint.add("joomla");
    // Body-level CMS/tech fingerprints (meta generator + well-known markers).
    const metaGenerator = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{1,80})["']/i.exec(res.body);
    if (metaGenerator) {
      const gen = metaGenerator[1]!.toLowerCase();
      for (const cms of ["wordpress", "drupal", "joomla", " TYPO3", "typo3", "shopware", "ghost", "wix"]) {
        if (gen.includes(cms.trim())) fingerprint.add(cms.trim());
      }
    }
    if (/\/wp-content\//.test(res.body)) fingerprint.add("wordpress");
    if (/\/media\/jui\//.test(res.body)) fingerprint.add("joomla");
    if (/\/drupal\/|\/sites\/default\/files\//.test(res.body)) fingerprint.add("drupal");
    if (/<spring-boot|X-Application-Context/i.test(res.body) || res.headers["x-application-context"]) fingerprint.add("spring");
    asset.techFingerprint = [...fingerprint].filter((f) => f.length > 0);
  } catch {
    // An unreachable target stays an empty asset; capabilities decide applicability.
  }
  return asset;
}

/**
 * Fingerprint → candidate CVE leads (AutoPWN + vulnx grafts, data level).
 * A lead is NOT a finding: it only narrows template selection for §6.6; every
 * reported claim still passes the evidence gate.
 */
const FINGERPRINT_LEADS: ReadonlyArray<{ match: string; cveId: string; reason: string }> = [
  { match: "php", cveId: "CVE-2024-4577", reason: "PHP CGI argument injection when PHP runs as CGI; verify version and SAPI" },
  { match: "wordpress", cveId: "CVE-2023-2745", reason: "WordPress core/plugin object injection family; verify version via templates" },
  { match: "drupal", cveId: "CVE-2018-7600", reason: "Drupalgeddon2 remote code execution; verify version via templates" },
  { match: "joomla", cveId: "CVE-2023-23752", reason: "Joomla unauthenticated information disclosure; verify version via templates" },
  { match: "asp.net", cveId: "CVE-2017-9822", reason: "ASP.NET deserialization family; verify via deser probes" },
  { match: "apache", cveId: "CVE-2021-41773", reason: "Apache path traversal when CGI is enabled; verify version via templates" },
  { match: "nginx", cveId: "CVE-2021-23017", reason: "nginx resolver off-by-one family; verify version via templates" },
  { match: "spring", cveId: "CVE-2022-22965", reason: "Spring4Shell class-binding RCE on WAR/JDK9+; verify via templates" },
  { match: "tomcat", cveId: "CVE-2017-12617", reason: "Tomcat PUT JSP upload RCE; verify via templates" },
  { match: "express", cveId: "CVE-2024-43796", reason: "Express body corruption family; verify via templates" },
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

/**
 * Fingerprint leads enriched with the live CISA KEV catalog: a lead whose CVE
 * is known-exploited is escalated (source "kev") so template selection
 * prioritizes it. The catalog is best-effort — when unreachable the static
 * fingerprint leads are returned unchanged (never a hard failure).
 */
export async function mapKnownVulnsWithKev(asset: RedReconAsset): Promise<CveLead[]> {
  const leads = mapKnownVulns(asset);
  if (!leads.length) return leads;
  try {
    const { loadKev } = await import("../../native/intel/kev.js");
    const kev = await loadKev({});
    if (kev.status !== "ok") return leads;
    return leads.map((l) =>
      kev.entries.has(l.cveId)
        ? { ...l, source: "kev" as const, reason: `${l.reason} — CVE is in the CISA KEV catalog (known exploited)` }
        : l,
    );
  } catch {
    return leads;
  }
}
