/**
 * Field encryption for the matters database: AES-256-GCM envelopes
 * "v1.<iv b64>.<tag b64>.<ciphertext b64>", with the record id bound as AAD so
 * an envelope copied onto another row fails to decrypt.
 *
 * Key custody (Design decision LD-8, default):
 *  - Electron main generates a random 32-byte data key once, wraps it with
 *    `safeStorage.encryptString` (Windows DPAPI, bound to the Windows user) and
 *    stores only the wrapped blob in `<DATA_DIR>/legal/.matters-key.dpapi`.
 *  - At server start it unwraps the key and posts it to the utility process over
 *    `serverChild.postMessage` (never via env, argv or a file in clear).
 *  - The server holds it in memory via `setMattersKey`; without a key, every
 *    matters read/write throws `LegalKeyUnavailableError` (fail closed).
 * Tests and the mock server use `StaticKeyProvider`.
 */
import crypto from "node:crypto";

export class LegalKeyUnavailableError extends Error {
  constructor() { super("legal matters key is not available (desktop key handoff missing); matters are locked"); }
}

export interface KeyProvider { key(): Buffer }

export class StaticKeyProvider implements KeyProvider {
  private readonly k: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("matters key must be 32 bytes");
    this.k = Buffer.from(key);
  }
  key(): Buffer { return this.k; }
}

let processKey: Buffer | null = null;

/** Called once by the server-host message handler with the unwrapped data key. */
export function setMattersKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("matters key must be 32 bytes");
  processKey = Buffer.from(key);
}

export function clearMattersKey(): void {
  if (processKey) processKey.fill(0);
  processKey = null;
}

export const processKeyProvider: KeyProvider = {
  key(): Buffer {
    if (!processKey) throw new LegalKeyUnavailableError();
    return processKey;
  },
};

export class FieldCipher {
  constructor(private readonly provider: KeyProvider) {}

  seal(plaintext: string, aad: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.provider.key(), iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
  }

  open(envelope: string, aad: string): string {
    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") throw new Error("unsupported envelope");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.provider.key(), Buffer.from(parts[1] ?? "", "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(parts[2] ?? "", "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3] ?? "", "base64")), decipher.final()]).toString("utf8");
  }

  sealJson(value: unknown, aad: string): string { return this.seal(JSON.stringify(value), aad); }
  openJson<T>(envelope: string, aad: string): T { return JSON.parse(this.open(envelope, aad)) as T; }
}
