import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FieldCipher, type KeyProvider } from "../crypto.js";

export class LegalFileVault {
  private readonly cipher: FieldCipher;
  constructor(private readonly dir: string, keys: KeyProvider) { this.cipher = new FieldCipher(keys); }

  put(data: Buffer): { id: string; sha256: string } {
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    const id = `file-${sha256.slice(0, 20)}`;
    const envelope = this.cipher.seal(data.toString("base64"), `legal-file:${id}`);
    fs.mkdirSync(this.dir, { recursive: true });
    const target = path.join(this.dir, `${id}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ format: "loam-legal-file/1", payload: envelope }));
    fs.renameSync(tmp, target);
    return { id, sha256 };
  }

  get(id: string): Buffer {
    if (!/^file-[0-9a-f]{20}$/.test(id)) throw new Error("invalid legal file id");
    const record = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8")) as { payload?: string };
    if (!record.payload) throw new Error("invalid legal file");
    return Buffer.from(this.cipher.open(record.payload, `legal-file:${id}`), "base64");
  }

  delete(id: string): boolean {
    if (!/^file-[0-9a-f]{20}$/.test(id)) throw new Error("invalid legal file id");
    const target = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target);
    return true;
  }
}
