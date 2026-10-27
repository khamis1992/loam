import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuditEntry } from "../red/audit.js";
import type { EvidenceCipher } from "./crypto.js";

export class SiemExporter {
  constructor(private readonly options: {
    endpoint: string;
    signingKey: Buffer;
    outboxFile: string;
    cipher?: EvidenceCipher;
    tenantId?: string;
    engagementId?: string;
    fetchFn?: typeof fetch;
  }) {
    const url = new URL(options.endpoint);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !loopback) || !["http:", "https:"].includes(url.protocol)) throw new Error("SIEM requires HTTPS except for a loopback test service");
    if (options.signingKey.length !== 32) throw new Error("SIEM signing key must be 32 bytes");
  }

  async export(entries: AuditEntry[]): Promise<{ delivered: boolean; outboxBytes: number }> {
    if (!entries.length) return { delivered: true, outboxBytes: 0 };
    const body = JSON.stringify({ events: entries.slice(0, 500) });
    try {
      const response = await (this.options.fetchFn ?? fetch)(this.options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-loam-signature": createHmac("sha256", this.options.signingKey).update(body).digest("hex") },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`SIEM returned HTTP ${response.status}`);
      return { delivered: true, outboxBytes: 0 };
    } catch (error) {
      const outboxBytes = await this.buffer(entries);
      if (!outboxBytes) throw error;
      return { delivered: false, outboxBytes };
    }
  }

  private async buffer(entries: AuditEntry[]): Promise<number> {
    if (!this.options.cipher || !this.options.tenantId || !this.options.engagementId) return 0;
    fs.mkdirSync(path.dirname(this.options.outboxFile), { recursive: true });
    const encrypted = await this.options.cipher.encrypt(this.options.tenantId, this.options.engagementId, "siem-outbox", JSON.stringify(entries));
    const data = JSON.stringify(encrypted);
    fs.writeFileSync(this.options.outboxFile, data, { mode: 0o600 });
    return Buffer.byteLength(data);
  }
}
