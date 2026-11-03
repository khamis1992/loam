import path from "node:path";
import { EvidenceCipher, HttpTenantKeyProvider } from "./crypto.js";
import { SiemExporter } from "./audit.js";

export function configuredEvidenceCipher(): EvidenceCipher | null {
  const baseUrl = process.env.LOAM_KMS_URL;
  const apiKey = process.env.LOAM_KMS_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return new EvidenceCipher(new HttpTenantKeyProvider({ baseUrl, apiKey }));
}

export function configuredSiemExporter(dataRoot: string, tenantId: string, engagementId: string): SiemExporter | null {
  const endpoint = process.env.LOAM_SIEM_ENDPOINT;
  const encodedKey = process.env.LOAM_SIEM_SIGNING_KEY;
  if (!endpoint || !encodedKey) return null;
  const signingKey = Buffer.from(encodedKey, "base64");
  return new SiemExporter({
    endpoint,
    signingKey,
    outboxFile: path.join(dataRoot, "siem-outbox", tenantId, `${engagementId}.json`),
    ...(configuredEvidenceCipher() ? { cipher: configuredEvidenceCipher()! } : {}),
    tenantId,
    engagementId,
  });
}
