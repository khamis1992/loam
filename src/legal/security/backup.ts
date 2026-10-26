import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FieldCipher, StaticKeyProvider, type KeyProvider } from "../crypto.js";

const FORMAT = "loam-legal-backup/1";
const AAD = "legal-backup/v1";

interface BackupFile {
  name: "matters.db" | "qatar-law.db";
  data: string;
}

interface BackupOptions {
  outputPath: string;
  mattersPath: string;
  corpusPath: string;
  keys: KeyProvider;
  passphrase: string;
  now?: () => Date;
}

interface RestoreOptions {
  inputPath: string;
  mattersPath: string;
  corpusPath: string;
  passphrase: string;
}

function backupKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 12) throw new Error("backup passphrase must contain at least 12 characters");
  return crypto.scryptSync(passphrase, salt, 32);
}

function atomicWrite(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function decodeBundle(raw: string, passphrase: string): { mattersKey: Buffer; files: BackupFile[] } {
  const bundle = JSON.parse(raw) as { format?: string; salt?: string; payload?: string };
  if (bundle.format !== FORMAT || !bundle.salt || !bundle.payload) throw new Error("unsupported legal backup");
  const salt = Buffer.from(bundle.salt, "base64");
  const cipher = new FieldCipher(new StaticKeyProvider(backupKey(passphrase, salt)));
  const opened = cipher.openJson<{ mattersKeyHex: string; files: BackupFile[] }>(bundle.payload, AAD);
  if (!/^[0-9a-f]{64}$/.test(opened.mattersKeyHex) || !Array.isArray(opened.files)) throw new Error("invalid legal backup payload");
  for (const file of opened.files) {
    if (file.name !== "matters.db" && file.name !== "qatar-law.db") throw new Error("unexpected file in legal backup");
    if (typeof file.data !== "string") throw new Error("invalid legal backup file");
  }
  return { mattersKey: Buffer.from(opened.mattersKeyHex, "hex"), files: opened.files };
}

export function createLegalBackup(opts: BackupOptions): void {
  const salt = crypto.randomBytes(16);
  const cipher = new FieldCipher(new StaticKeyProvider(backupKey(opts.passphrase, salt)));
  const files: BackupFile[] = [
    { name: "matters.db", data: fs.readFileSync(opts.mattersPath).toString("base64") },
    { name: "qatar-law.db", data: fs.readFileSync(opts.corpusPath).toString("base64") },
  ];
  const payload = cipher.sealJson({ createdAt: (opts.now?.() ?? new Date()).toISOString(), mattersKeyHex: opts.keys.key().toString("hex"), files }, AAD);
  atomicWrite(opts.outputPath, `${JSON.stringify({ format: FORMAT, salt: salt.toString("base64"), payload }, null, 2)}\n`);
}

export function restoreLegalBackup(opts: RestoreOptions): { mattersKey: Buffer; restored: string[] } {
  const opened = decodeBundle(fs.readFileSync(opts.inputPath, "utf8"), opts.passphrase);
  const restored: string[] = [];
  for (const file of opened.files) {
    const target = file.name === "matters.db" ? opts.mattersPath : opts.corpusPath;
    atomicWrite(target, Buffer.from(file.data, "base64"));
    restored.push(target);
  }
  return { mattersKey: opened.mattersKey, restored };
}
