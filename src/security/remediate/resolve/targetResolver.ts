/** TargetResolver — REMEDIATE_INTO_LOAM §5.3 (Phase B). A target is `verified`
 *  ONLY when (1) it is a member of the advisory pack (pack membership, hash
 *  pinned) AND (2) existence evidence was fetched from a registry/vendor index.
 *  Never guesses; failures are `unverified` (reason) or `not_found`, never
 *  silently verified. All fetched content is untrusted — field extraction only.
 *  Fetcher is injectable for tests (stubs); production uses global fetch with
 *  the REMEDIATE_LIMITS caps. */
import { createHash } from "node:crypto";
import type { TargetEvidence, TargetVerification, VulnRecord } from "../types.js";
import { REMEDIATE_LIMITS } from "../types.js";
import type { AdvisoryPack } from "../packs/schema.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Registry v2 HEAD-style manifest check (accepts OCI index + docker list). */
export async function fetchRegistryManifest(image: string, fetcher: FetchLike = fetch, registryBase = "https://registry-1.docker.io/v2"): Promise<{ status: "verified" | "not_found" | "unverified"; evidence?: TargetEvidence; reason?: string }> {
  const [name, tag] = image.includes("@sha256:") ? [image.split("@")[0]!, `sha256:${image.split("@sha256:")[1]}`] : [image.split(":")[0]!, image.split(":")[1] ?? "latest"];
  const url = `${registryBase}/${name}/manifests/${tag}`;
  try {
    const res = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" },
    });
    if (res.status === 404) return { status: "not_found", reason: `registry 404: ${image}` };
    if (res.status === 401 || res.status === 403) {
      // Auth-gated: an anonymous 401 with a Docker-Token realm still proves the
      // repository exists; a 401 without realm does not. Keep honest: unverified.
      return { status: "unverified", reason: `registry ${res.status}: auth required for ${image}` };
    }
    if (!res.ok) return { status: "unverified", reason: `registry HTTP ${res.status}` };
    const digestHeader = res.headers.get("docker-content-digest") ?? "";
    const body = await res.text();
    if (body.length > REMEDIATE_LIMITS.maxNetworkBytesPerResponse) return { status: "unverified", reason: "manifest body over cap" };
    const digest = digestHeader || `sha256:${createHash("sha256").update(body).digest("hex")}`;
    return {
      status: "verified",
      evidence: {
        kind: "registry_manifest", at: new Date().toISOString(), url,
        httpStatus: res.status, digest,
        value: tag.startsWith("sha256:") ? tag : tag,
        detail: `manifest digest ${digest.slice(0, 20)}… for ${image}`,
      },
    };
  } catch (err) {
    return { status: "unverified", reason: `registry unreachable: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}` };
  }
}

/** Vendor release-index check (nodejs.org / php.net / electron releases). */
export async function fetchVendorReleaseIndex(url: string, extract: (body: string) => string | null, fetcher: FetchLike = fetch): Promise<{ status: "verified" | "not_found" | "unverified"; evidence?: TargetEvidence; reason?: string }> {
  try {
    const res = await fetcher(url);
    if (res.status === 404) return { status: "not_found", reason: `index 404: ${url}` };
    if (!res.ok) return { status: "unverified", reason: `index HTTP ${res.status}` };
    const body = await res.text();
    if (body.length > REMEDIATE_LIMITS.maxNetworkBytesPerResponse) return { status: "unverified", reason: "index body over cap" };
    const value = extract(body);
    if (value === null) return { status: "not_found", reason: `version not present in index: ${url}` };
    return {
      status: "verified",
      evidence: { kind: "vendor_release_index", at: new Date().toISOString(), url, httpStatus: res.status, bodySha256: createHash("sha256").update(body).digest("hex"), value, detail: `release index lists ${value}` },
    };
  } catch (err) {
    return { status: "unverified", reason: `index unreachable: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}` };
  }
}

/** Node dist index: https://nodejs.org/dist/index.json contains {"version":"v22.23.4",...}. */
export function nodeDistExtract(fixed: string): (body: string) => string | null {
  return (body) => (body.includes(`"version":"v${fixed}"`) || body.includes(`"version": "v${fixed}"`) ? fixed : null);
}

/** PHP releases JSON: https://www.php.net/releases/index.php?json&version=8.3 → "8.3.36". */
export function phpReleaseExtract(fixed: string): (body: string) => string | null {
  return (body) => (body.includes(fixed) ? fixed : null);
}

/** The resolver: pack membership (checked locally against the hash-pinned pack)
 *  + existence evidence (fetched). Returns a full TargetVerification. */
export async function resolveTarget(
  record: VulnRecord,
  pack: AdvisoryPack,
  packSha256: string,
  opts: { fetcher?: FetchLike } = {},
): Promise<TargetVerification> {
  const fetcher = opts.fetcher ?? fetch;
  const value = record.proposedTarget;

  // Electron tracker: policy forbids any proposal without verified releases.
  if (pack.id === "electron-bundled-node") {
    const verifiedRelease = (pack.verifiedFixedElectronReleases ?? []).find((v) => v.bundledNode >= "24.22.1" || v.bundledNode >= "22.23.4");
    if (!verifiedRelease) {
      return {
        target: { value: "none", line: "electron", packId: pack.id, packSha256 },
        status: "unverified",
        reason: "no verified Electron release bundles a fixed Node (pack verifiedFixedElectronReleases empty)",
        evidence: [],
      };
    }
  }

  // Pack membership: the target must be a pack fixed version for the row's line.
  if (value === null) {
    return {
      target: { value: "none", line: pack.lines[0]?.line ?? "?", packId: pack.id, packSha256 },
      status: record.status === "eol" ? "not_found" : "unverified",
      reason: record.status === "eol" ? "line is EOL — no fixed release exists; upgrade path required" : "no proposed target",
      evidence: [],
    };
  }
  const member = pack.lines.some((l) => l.fixed === value) || (pack.knownBackports ?? []).some((b) => b.release === value);
  if (!member) {
    return {
      target: { value, line: "?", packId: pack.id, packSha256 },
      status: "unverified",
      reason: `target ${value} is not in the pack's fixedReleases or knownBackports`,
      evidence: [],
    };
  }

  // Existence evidence by ecosystem/channel.
  const evidence: TargetEvidence[] = [];
  let outcome: "verified" | "unverified" | "not_found" = "unverified";
  let reason: string | undefined;

  if (pack.product === "nodejs") {
    const r = await fetchVendorReleaseIndex("https://nodejs.org/dist/index.json", nodeDistExtract(value), fetcher);
    if (r.evidence) evidence.push(r.evidence);
    outcome = r.status;
    reason = r.reason;
  } else if (pack.product === "php") {
    const minor = value.split(".").slice(0, 2).join(".");
    const r = await fetchVendorReleaseIndex(`https://www.php.net/releases/index.php?json&version=${minor}`, phpReleaseExtract(value), fetcher);
    if (r.evidence) evidence.push(r.evidence);
    outcome = r.status;
    reason = r.reason;
  } else if (pack.product === "gitlab-self-managed") {
    // packages.gitlab.com index for omnibus releases.
    const r = await fetchVendorReleaseIndex(`https://packages.gitlab.com/app/gitlab/gitlab-ee/redirect_packages?version=${value}-ee.0`, () => value, fetcher);
    if (r.evidence) evidence.push(r.evidence);
    outcome = r.status;
    reason = r.reason;
  }

  return { target: { value, line: pack.lines.find((l) => l.fixed === value)?.line ?? "?", packId: pack.id, packSha256 }, status: outcome, reason, evidence };
}
