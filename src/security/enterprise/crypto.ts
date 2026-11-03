import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface TenantKeyProvider {
  dataKey(tenantId: string, engagementId: string): Promise<Buffer>;
}

export interface EncryptedEvidence {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export class EvidenceCipher {
  constructor(private readonly keys: TenantKeyProvider) {}

  async encrypt(tenantId: string, engagementId: string, artifactId: string, plaintext: Buffer | string): Promise<EncryptedEvidence> {
    const key = await this.keys.dataKey(tenantId, engagementId);
    if (key.length !== 32) throw new Error("tenant data key must be 32 bytes");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${tenantId}\n${engagementId}\n${artifactId}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }

  async decrypt(tenantId: string, engagementId: string, artifactId: string, encrypted: EncryptedEvidence): Promise<Buffer> {
    if (encrypted.version !== 1 || encrypted.algorithm !== "aes-256-gcm") throw new Error("unsupported evidence encryption");
    const key = await this.keys.dataKey(tenantId, engagementId);
    if (key.length !== 32) throw new Error("tenant data key must be 32 bytes");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
    decipher.setAAD(Buffer.from(`${tenantId}\n${engagementId}\n${artifactId}`, "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]);
  }
}

export class HttpTenantKeyProvider implements TenantKeyProvider {
  constructor(private readonly options: { baseUrl: string; apiKey: string; fetchFn?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !loopback) || !["http:", "https:"].includes(url.protocol)) throw new Error("KMS requires HTTPS except for a loopback test service");
  }

  async dataKey(tenantId: string, engagementId: string): Promise<Buffer> {
    const response = await (this.options.fetchFn ?? fetch)(new URL("/v1/data-key", this.options.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ tenantId, engagementId }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`KMS returned HTTP ${response.status}`);
    const body = await response.json() as { key?: unknown };
    if (typeof body.key !== "string") throw new Error("KMS returned no data key");
    const key = Buffer.from(body.key, "base64");
    if (key.length !== 32) throw new Error("KMS returned an invalid data key");
    return key;
  }
}
