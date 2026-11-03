import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const fileType = require("file-type") as { fromBuffer(data: Buffer): Promise<{ mime: string } | undefined> };
const Jimp = require("jimp") as {
  new (width: number, height: number, color: number): {
    getBuffer(mime: string, callback: (error: Error | null, data: Buffer) => void): void;
  };
  MIME_PNG: string;
  read(data: Buffer): Promise<{ bitmap: { width: number; height: number } }>;
};

test("file-type compatibility preserves Jimp PNG reads", async () => {
  const image = new Jimp(2, 2, 0xff0000ff);
  const encoded = await new Promise<Buffer>((resolve, reject) => {
    image.getBuffer(Jimp.MIME_PNG, (error, data) => error ? reject(error) : resolve(data));
  });
  const decoded = await Jimp.read(encoded);
  assert.equal(decoded.bitmap.width, 2);
  assert.equal(decoded.bitmap.height, 2);
  assert.equal((await fileType.fromBuffer(encoded))?.mime, "image/png");
});

test("fixed ASF parser rejects a zero-size sub-header without hanging", async () => {
  const malformed = Buffer.alloc(100);
  Buffer.from([0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9]).copy(malformed);
  await assert.doesNotReject(async () => {
    await Promise.race([
      fileType.fromBuffer(malformed),
      new Promise((_, reject) => setTimeout(() => reject(new Error("ASF parser timed out")), 500)),
    ]);
  });
});
