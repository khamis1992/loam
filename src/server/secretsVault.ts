/**
 * Companion secrets vault (frontier section 18): per-companion secrets stored
 * encrypted at rest (AES-256-GCM with a machine-local key file). Values NEVER
 * enter model context, tool arguments or logs — only names are ever listed;
 * the value is resolved server-side and written straight into the companion's
 * own device when a run needs it (device_write_secret tool).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../config.js";
import { log } from "../log.js";
import { registerSecretValue, unregisterSecretValue } from "../log.js";

const DIR = path.join(DATA_DIR, "secrets-vault");
const KEY_FILE = path.join(DIR, ".vault-key");

function masterKey(): Buffer {
  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE)) {
    const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length === 32) return key;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString("base64"), { mode: 0o600 });
  return key;
}

interface SealedSecret {
  iv: string;
  tag: string;
  value: string;
  at: string;
}

function storeFile(agentId: string): string {
  return path.join(DIR, `${agentId.replace(/[^\w-]/g, "_")}.json`);
}

function readStore(agentId: string): Record<string, SealedSecret> {
  try {
    return JSON.parse(fs.readFileSync(storeFile(agentId), "utf8")) as Record<string, SealedSecret>;
  } catch {
    return {};
  }
}

function writeStore(agentId: string, store: Record<string, SealedSecret>): void {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${storeFile(agentId)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1), "utf8");
  fs.renameSync(tmp, storeFile(agentId));
}

const seal = (plaintext: string): SealedSecret => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const value = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), value, at: new Date().toISOString() };
};

const unseal = (sealed: SealedSecret): string => {
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.value, "base64")), decipher.final()]).toString("utf8");
};

const NAME_RE = /^[A-Za-z0-9_.-]{1,48}$/;

export function setSecret(agentId: string, name: string, value: string): true | { error: string } {
  if (!NAME_RE.test(name)) return { error: "اسم السر يجب أن يكون حروفًا إنجليزية وأرقامًا وشرطات (≤48 حرفًا)" };
  if (!value || value.length > 8192) return { error: "قيمة السر مطلوبة (≤8KB)" };
  const store = readStore(agentId);
  store[name] = seal(value);
  writeStore(agentId, store);
  log.info(`vault: secret "${name}" stored for agent ${agentId} (value never logged)`);
  registerSecretValue(value);
  return true;
}

/** Names only — never values. */
export function listSecrets(agentId: string): Array<{ name: string; at: string }> {
  return Object.entries(readStore(agentId)).map(([name, sealed]) => ({ name, at: sealed.at })).sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteSecret(agentId: string, name: string): boolean {
  const store = readStore(agentId);
  if (!store[name]) return false;
  try { unregisterSecretValue(unseal(store[name])); } catch { /* already gone */ }
  delete store[name];
  writeStore(agentId, store);
  return true;
}

/** Server-side resolution — the ONLY place a value becomes plaintext, and the
 *  caller must never forward it into model context or logs. */
export function resolveSecret(agentId: string, name: string): string | null {
  const sealed = readStore(agentId)[name];
  if (!sealed) return null;
  try {
    return unseal(sealed);
  } catch {
    log.warn(`vault: failed to unseal "${name}" for ${agentId}`);
    return null;
  }
}
