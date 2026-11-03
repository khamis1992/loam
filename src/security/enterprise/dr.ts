import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface BackupEntry { path: string; sha256: string; bytes: number }
interface BackupManifest { version: 1; createdAt: string; encrypted: boolean; files: BackupEntry[]; signature?: string }

const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};
const sign = (manifest: Omit<BackupManifest, "signature">, key: Buffer): string => createHmac("sha256", key).update(JSON.stringify(manifest)).digest("hex");

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("backup rejects symbolic links");
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}

function encrypt(data: Buffer, relative: string, key?: Buffer): Buffer {
  if (!key) return data;
  if (key.length !== 32) throw new Error("DR encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(relative));
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(data: Buffer, relative: string, encrypted: boolean, key?: Buffer): Buffer {
  if (!encrypted) return data;
  if (!key || key.length !== 32 || data.length < 28) throw new Error("valid DR encryption key and payload required");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(relative));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
}

export function createDrBackup(sourceRoot: string, backupRoot: string, signingKey: Buffer, encryptionKey?: Buffer): string {
  if (signingKey.length !== 32) throw new Error("DR signing key must be 32 bytes");
  const source = path.resolve(sourceRoot);
  const backup = path.resolve(backupRoot);
  if (inside(source, backup) || !fs.existsSync(source)) throw new Error("invalid backup source or destination");
  fs.mkdirSync(backup, { recursive: true });
  const files: BackupEntry[] = [];
  for (const file of filesUnder(source)) {
    const relative = path.relative(source, file).replace(/\\/g, "/");
    const data = fs.readFileSync(file);
    const destination = path.join(backup, "files", relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, encrypt(data, relative, encryptionKey), { flag: "wx" });
    files.push({ path: relative, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), encrypted: Boolean(encryptionKey), files };
  manifest.signature = sign(manifest, signingKey);
  fs.writeFileSync(path.join(backup, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  return path.join(backup, "manifest.json");
}

export function restoreDrBackup(backupRoot: string, restoreRoot: string, signingKey: Buffer, encryptionKey?: Buffer): void {
  const backup = path.resolve(backupRoot);
  const restore = path.resolve(restoreRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, "manifest.json"), "utf8")) as BackupManifest;
  const { signature, ...unsigned } = manifest;
  if (manifest.version !== 1 || signature !== sign(unsigned, signingKey) || manifest.files.length > 10_000) throw new Error("backup manifest integrity failed");
  for (const entry of manifest.files) {
    if (!entry.path || entry.path.includes("..") || path.isAbsolute(entry.path)) throw new Error("unsafe backup path");
    const source = path.join(backup, "files", entry.path);
    let data: Buffer;
    try {
      data = decrypt(fs.readFileSync(source), entry.path, manifest.encrypted, encryptionKey);
    } catch {
      throw new Error(`backup content mismatch: ${entry.path}`);
    }
    if (createHash("sha256").update(data).digest("hex") !== entry.sha256 || data.length !== entry.bytes) throw new Error(`backup content mismatch: ${entry.path}`);
    const destination = path.join(restore, entry.path);
    if (!inside(restore, destination)) throw new Error("restore path escapes destination");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data, { flag: "wx" });
  }
}
