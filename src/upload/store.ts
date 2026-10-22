import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { PresignRequest, StoredFile, CompleteRequest } from './types.js';

export class FileStore {
  readonly dir: string;
  private files = new Map<string, StoredFile>();

  constructor(dir?: string) {
    this.dir = dir ?? path.join(os.tmpdir(), 'loam-uploads-a08');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  reserve(input: PresignRequest): { id: string } {
    const id = randomBytes(16).toString('hex');
    // Record metadata without content; content arrives with PUT.
    this.files.set(id, {
      id,
      filename: input.filename,
      contentType: input.fileType,
      size: input.fileSize,
      path: this.blobPath(id),
    });
    return { id };
  }

  save(id: string, data: Buffer): StoredFile {
    const existing = this.files.get(id);
    if (!existing) {
      throw new Error('upload id not reserved');
    }
    fs.writeFileSync(existing.path, data);
    const stored: StoredFile = { ...existing, size: data.length };
    this.files.set(id, stored);
    return stored;
  }

  get(id: string): StoredFile | undefined {
    return this.files.get(id);
  }

  getBuffer(id: string): Buffer | undefined {
    const f = this.files.get(id);
    if (!f || !fs.existsSync(f.path)) return undefined;
    return fs.readFileSync(f.path);
  }

  complete(input: CompleteRequest): StoredFile {
    const f = this.files.get(input.id);
    if (!f) throw new Error('upload id not found');
    const buf = this.getBuffer(input.id);
    if (!buf) throw new Error('upload bytes missing');
    if (buf.length !== input.fileSize) {
      throw new Error(`size mismatch: expected ${input.fileSize}, got ${buf.length}`);
    }
    const stored: StoredFile = { ...f, filename: input.filename, size: buf.length };
    this.files.set(input.id, stored);
    return stored;
  }

  blobPath(id: string): string {
    return path.join(this.dir, id);
  }

  clear(): void {
    for (const f of this.files.values()) {
      try { fs.unlinkSync(f.path); } catch { /* ignore */ }
    }
    this.files.clear();
  }
}
