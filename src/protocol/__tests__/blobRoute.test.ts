/**
 * J6: the `/blob/` PUT route must not let a single upload break the byte ceiling.
 *
 * `storeBlob` refuses an upload larger than `BLOB_STORE_MAX_BYTES` (and the
 * eviction hook refuses to drop the last entry), so the route has to answer 413
 * rather than buffer the bytes and then report a cache that is permanently over
 * budget. Drives the real adapter on an ephemeral port.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { startProtocolAdapter, type ProtocolAdapter } from "../adapter.js";
import { BLOB_STORE_MAX_BYTES, clearBlobs } from "../blobStore.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-blob-route-"));
process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
process.env.LOAM_AUTH_DISABLED = "true";

const cfg = {
  model: "test-model",
  workspace: process.cwd(),
  policy: { networkEnabled: false },
} as never;

let adapter: ProtocolAdapter | undefined;

before(async () => {
  adapter = await startProtocolAdapter({
    cfg,
    runTask: (async () => ({ taskId: "t", text: "" })) as never,
    getTask: () => undefined,
    port: 0,
  });
});

after(async () => {
  await adapter?.close();
  adapter = undefined;
  clearBlobs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Reserve an upload id through the real presign route. */
async function presign(): Promise<{ uploadUrl: string; id: string }> {
  const res = await fetch(`http://127.0.0.1:${adapter!.port}/api/chat/getPresignedUploadUrl`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: "f.bin", fileType: "application/octet-stream", fileSize: 1 }),
  });
  assert.equal(res.status, 200, "presign must succeed");
  return ((await res.json()) as { data: { uploadUrl: string; id: string } }).data;
}

describe("protocol adapter /blob/ byte ceiling", () => {
  it("stores an in-budget upload", async () => {
    clearBlobs();
    const { uploadUrl } = await presign();
    const res = await fetch(uploadUrl, { method: "PUT", body: Buffer.alloc(1024, 7) });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  });

  it("rejects an over-ceiling upload with 413 instead of buffering it", async () => {
    clearBlobs();
    const { uploadUrl } = await presign();
    const res = await fetch(uploadUrl, {
      method: "PUT",
      body: Buffer.alloc(BLOB_STORE_MAX_BYTES + 1024, 1),
    });
    assert.equal(res.status, 413, `expected 413, got ${res.status}`);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "payload_too_large");
  });

  it("accepts an upload exactly at the ceiling", async () => {
    clearBlobs();
    const { uploadUrl } = await presign();
    const res = await fetch(uploadUrl, { method: "PUT", body: Buffer.alloc(BLOB_STORE_MAX_BYTES, 3) });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  });
});
