import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FieldCipher, StaticKeyProvider, type KeyProvider } from "../crypto.js";

const FORMAT = "loam-legal-backup/1";
const AAD = "legal-backup/v1";

interface BackupFile {
  name: string;
  data: string;
  sha256?: string;
}

interface BackupOptions {
  outputPath: string;
  mattersPath: string;
  corpusPath: string;
  filesDir?: string;
  keys: KeyProvider;
  passphrase: string;
  now?: () => Date;
}

interface RestoreOptions {
  inputPath: string;
  mattersPath: string;
  corpusPath: string;
  filesDir?: string;
  passphrase: string;
  /** Existing databases and vault files are never overwritten unless this is explicitly true. */
  overwrite?: boolean;
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

function fileRecord(name: string, data: Buffer): BackupFile {
  return { name, data: data.toString("base64"), sha256: crypto.createHash("sha256").update(data).digest("hex") };
}

function decodeBundle(raw: string, passphrase: string): { mattersKey: Buffer; files: BackupFile[]; createdAt: string } {
  const bundle = JSON.parse(raw) as { format?: string; salt?: string; payload?: string };
  if (bundle.format !== FORMAT || !bundle.salt || !bundle.payload) throw new Error("unsupported legal backup");
  const salt = Buffer.from(bundle.salt, "base64");
  if (salt.length !== 16) throw new Error("invalid legal backup salt");
  const cipher = new FieldCipher(new StaticKeyProvider(backupKey(passphrase, salt)));
  const opened = cipher.openJson<{ createdAt: string; mattersKeyHex: string; files: BackupFile[] }>(bundle.payload, AAD);
  if (!/^[0-9a-f]{64}$/.test(opened.mattersKeyHex) || !Array.isArray(opened.files) || !Number.isFinite(Date.parse(opened.createdAt))) throw new Error("invalid legal backup payload");
  const names = new Set<string>();
  for (const file of opened.files) {
    if (file.name !== "matters.db" && file.name !== "qatar-law.db" && !/^files\/file-[0-9a-f]{20}\.json$/.test(file.name)) throw new Error("unexpected file in legal backup");
    if (names.has(file.name) || typeof file.data !== "string") throw new Error("invalid or duplicate legal backup file");
    names.add(file.name);
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== file.data) throw new Error("invalid legal backup file encoding");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (file.sha256 && file.sha256 !== digest) throw new Error("legal backup file hash mismatch");
    file.sha256 = digest;
  }
  if (!names.has("matters.db") || !names.has("qatar-law.db")) throw new Error("legal backup is missing a database");
  return { mattersKey: Buffer.from(opened.mattersKeyHex, "hex"), files: opened.files, createdAt: opened.createdAt };
}

export function inspectLegalBackup(inputPath: string, passphrase: string): { createdAt: string; files: Array<{ name: string; bytes: number; sha256: string }> } {
  const opened = decodeBundle(fs.readFileSync(inputPath, "utf8"), passphrase);
  return { createdAt: opened.createdAt, files: opened.files.map((file) => ({ name: file.name, bytes: Buffer.from(file.data, "base64").length, sha256: file.sha256! })) };
}

export function createLegalBackup(opts: BackupOptions): void {
  if ([opts.mattersPath, opts.corpusPath].some((file) => path.resolve(file) === path.resolve(opts.outputPath))) throw new Error("backup output must differ from the live databases");
  const salt = crypto.randomBytes(16);
  const cipher = new FieldCipher(new StaticKeyProvider(backupKey(opts.passphrase, salt)));
  const files: BackupFile[] = [
    fileRecord("matters.db", fs.readFileSync(opts.mattersPath)),
    fileRecord("qatar-law.db", fs.readFileSync(opts.corpusPath)),
  ];
  if (opts.filesDir && fs.existsSync(opts.filesDir)) {
    for (const name of fs.readdirSync(opts.filesDir)) {
      if (/^file-[0-9a-f]{20}\.json$/.test(name)) files.push(fileRecord(`files/${name}`, fs.readFileSync(path.join(opts.filesDir, name))));
    }
  }
  const payload = cipher.sealJson({ createdAt: (opts.now?.() ?? new Date()).toISOString(), mattersKeyHex: opts.keys.key().toString("hex"), files }, AAD);
  atomicWrite(opts.outputPath, `${JSON.stringify({ format: FORMAT, salt: salt.toString("base64"), payload }, null, 2)}\n`);
}

export function restoreLegalBackup(opts: RestoreOptions): { mattersKey: Buffer; restored: string[] } {
  const opened = decodeBundle(fs.readFileSync(opts.inputPath, "utf8"), opts.passphrase);
  if (path.resolve(opts.mattersPath) === path.resolve(opts.corpusPath)) throw new Error("restore targets must be different files");
  const targets = opened.files.map((file) => ({
    file,
    data: Buffer.from(file.data, "base64"),
    target: file.name === "matters.db" ? opts.mattersPath : file.name === "qatar-law.db" ? opts.corpusPath : path.join(opts.filesDir ?? "", path.basename(file.name)),
  }));
  if (targets.some(({ file }) => file.name.startsWith("files/")) && !opts.filesDir) throw new Error("filesDir is required for a backup containing evidence files");
  if (new Set(targets.map(({ target }) => path.resolve(target))).size !== targets.length) throw new Error("restore targets collide");
  if (!opts.overwrite && targets.some(({ target }) => fs.existsSync(target))) throw new Error("restore target exists; choose an empty destination or explicitly allow overwrite");
  const restored: string[] = [];
  for (const { target, data } of targets) {
    atomicWrite(target, data);
    restored.push(target);
  }
  return { mattersKey: opened.mattersKey, restored };
}
