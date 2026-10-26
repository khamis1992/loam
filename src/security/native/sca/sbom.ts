/**
 * First-party CycloneDX 1.5 SBOM writer over the discovered package inventory
 * (ALL_SERVICES §6). Round-trips with our own parseCycloneDx reader; purls use the
 * ecosystem→type map inverse. No network, no engine — the in-app fast path.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Pkg } from "./lockfiles.js";

const PURL_TYPE: Record<Pkg["ecosystem"], string> = {
  npm: "npm", PyPI: "pypi", Go: "golang", "crates.io": "cargo", RubyGems: "gem", Packagist: "composer", Maven: "maven",
};

const encode = (s: string): string => encodeURIComponent(s).replace(/%2F/gi, "/");

export function pkgToPurl(p: Pkg): string {
  return `pkg:${PURL_TYPE[p.ecosystem]}/${encode(p.name)}@${encode(p.version)}`;
}

export function toCycloneDx(pkgs: Pkg[], meta: { name: string; version?: string } = { name: "loam-workspace" }): Record<string, unknown> {
  const components = pkgs.map((p) => ({
    type: "library",
    "bom-ref": pkgToPurl(p),
    name: p.name,
    version: p.version,
    purl: pkgToPurl(p),
    properties: [{ name: "loam:ecosystem", value: p.ecosystem }, { name: "loam:source-file", value: p.file }],
  }));
  const doc = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: { component: { type: "application", name: meta.name, ...(meta.version ? { version: meta.version } : {}) }, timestamp: new Date().toISOString() },
    components,
  };
  return doc;
}

/** Stable digest of the package set (sorted purls) — SBOM identity without the serial. */
export function sbomDigest(pkgs: Pkg[]): string {
  const purls = pkgs.map(pkgToPurl).sort();
  return createHash("sha256").update(purls.join("\n")).digest("hex");
}
