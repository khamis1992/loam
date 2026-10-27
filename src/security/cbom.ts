export interface CryptoAsset {
  name: string;
  kind: "key" | "certificate" | "algorithm" | "protocol" | "signature";
  algorithm: string;
  keySize?: number;
  curve?: string;
  dataLongevityDays?: number;
  pqcMode?: "ML-KEM" | "ML-DSA" | "SLH-DSA" | "FN-DSA" | "hybrid";
}

export interface CbomAssessment extends CryptoAsset {
  readiness: "ready" | "hybrid" | "planned" | "unknown";
  reason: string;
}

const pqcAlgorithms = new Set(["ML-KEM", "ML-DSA", "SLH-DSA", "FN-DSA", "HYBRID"]);

export function assessCryptoAsset(asset: CryptoAsset): CbomAssessment {
  const algorithm = asset.algorithm.toUpperCase();
  if (asset.pqcMode || pqcAlgorithms.has(algorithm)) return { ...asset, readiness: asset.pqcMode === "hybrid" ? "hybrid" : "ready", reason: "declared post-quantum or hybrid mode; validate provider support" };
  if (/ML-KEM|ML-DSA|SLH-DSA|FN-DSA/.test(algorithm)) return { ...asset, readiness: "ready", reason: "post-quantum algorithm declared" };
  if (/RSA|ECDSA|ECDH|ED25519|X25519/.test(algorithm)) return { ...asset, readiness: "planned", reason: "quantum-vulnerable algorithm requires migration planning" };
  return { ...asset, readiness: "unknown", reason: "quantum readiness cannot be inferred from this algorithm" };
}

export function buildCbom(assets: CryptoAsset[], name = "loam-crypto-inventory"): { bomFormat: string; specVersion: string; version: number; metadata: { component: { type: string; name: string } }; components: unknown[] } {
  const assessed = assets.map(assessCryptoAsset);
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    version: 1,
    metadata: { component: { type: "application", name } },
    components: assessed.map((asset) => ({
      type: "cryptographic-asset",
      name: asset.name,
      cryptoProperties: {
        assetType: asset.kind,
        algorithmProperties: { algorithm: asset.algorithm, ...(asset.keySize ? { keySize: asset.keySize } : {}), ...(asset.curve ? { curve: asset.curve } : {}), ...(asset.pqcMode ? { pqcMode: asset.pqcMode } : {}) },
        ...(asset.dataLongevityDays !== undefined ? { dataLongevityDays: asset.dataLongevityDays } : {}),
        quantumReadiness: asset.readiness,
        readinessReason: asset.reason,
      },
    })),
  };
}
