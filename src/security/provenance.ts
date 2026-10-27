import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface BuildProvenance {
  version: "slsa-1.2";
  buildType: string;
  builderId: string;
  source: { uri: string; digestSha256: string };
  materials: Array<{ uri: string; digestSha256: string }>;
  signature: string;
}

const unsigned = (value: BuildProvenance): Omit<BuildProvenance, "signature"> => {
  const { signature: _signature, ...rest } = value;
  return rest;
};
const digest = (value: unknown, key: Buffer): string => createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");

export function signProvenance(input: Omit<BuildProvenance, "signature">, key: Buffer): BuildProvenance {
  if (key.length !== 32) throw new Error("provenance signing key must be 32 bytes");
  if (!input.source.digestSha256 || input.materials.some((material) => !material.digestSha256) || !input.builderId.trim()) throw new Error("incomplete provenance");
  return { ...input, signature: digest(unsigned({ ...input, signature: "" }), key) };
}

export function verifyProvenance(provenance: BuildProvenance, key: Buffer, artifacts: Record<string, Buffer>): { valid: boolean; reason: string } {
  const actual = Buffer.from(provenance.signature ?? "", "hex");
  const expected = Buffer.from(digest(unsigned(provenance), key), "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { valid: false, reason: "provenance signature mismatch" };
  const artifactsToCheck = [provenance.source, ...provenance.materials];
  for (const artifact of artifactsToCheck) {
    const content = artifacts[artifact.uri];
    if (!content) return { valid: false, reason: `missing artifact ${artifact.uri}` };
    if (createHash("sha256").update(content).digest("hex") !== artifact.digestSha256) return { valid: false, reason: `artifact digest mismatch ${artifact.uri}` };
  }
  return { valid: true, reason: "signature and reproducible artifact digests verified" };
}

export class CosignVerifier {
  constructor(private readonly options: { url: string; fetchFn?: typeof fetch }) {
    const url = new URL(options.url);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !loopback) || !["http:", "https:"].includes(url.protocol)) throw new Error("cosign verification requires HTTPS outside loopback");
  }

  async verify(provenance: BuildProvenance): Promise<{ valid: boolean; reason: string }> {
    const response = await (this.options.fetchFn ?? fetch)(this.options.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(provenance), redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`cosign verifier returned HTTP ${response.status}`);
    const result = await response.json() as { valid?: unknown; reason?: unknown };
    return { valid: result.valid === true, reason: typeof result.reason === "string" ? result.reason.slice(0, 300) : "external verification completed" };
  }
}
