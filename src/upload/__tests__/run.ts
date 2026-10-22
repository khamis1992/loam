import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createUploadServer,
  onDeviceAttachmentUpload,
  emitDeviceAttachmentUpload,
} from '../index.js';

async function main(): Promise<void> {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-upload-test-'));
  let baseUrl = '';
  const server = createUploadServer({ baseUrl: () => baseUrl, storageDir });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('unexpected server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const content = Buffer.from('Hello from A8 upload round-trip test.', 'utf8');

    // Step 1: get presigned URL.
    const presignRes = await fetch(`${baseUrl}/api/chat/getPresignedUploadUrl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'hello.txt', fileType: 'text/plain', fileSize: content.length }),
    });
    assert.strictEqual(presignRes.status, 200, 'presign status');
    const presignBody = (await presignRes.json()) as { data: { uploadUrl: string; id: string } };
    const { uploadUrl, id } = presignBody.data;
    assert.ok(uploadUrl.startsWith(baseUrl + '/blob/'), 'uploadUrl points at local blob route');
    assert.ok(id.length > 0, 'upload id returned');

    // Step 2: PUT raw bytes.
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: content,
    });
    assert.strictEqual(putRes.status, 200, 'PUT status');

    // Step 3: complete upload.
    const completeRes = await fetch(`${baseUrl}/api/chat/uploadComplete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'hello.txt', fileSize: content.length, id }),
    });
    assert.strictEqual(completeRes.status, 200, 'complete status');
    const completeBody = (await completeRes.json()) as { data: { fileUrl: string } };
    const { fileUrl } = completeBody.data;
    assert.ok(fileUrl.includes(`/blob/${id}`), 'fileUrl references the same blob id');

    // Step 4: download and verify content round-trip.
    const downloadRes = await fetch(fileUrl);
    assert.strictEqual(downloadRes.status, 200, 'download status');
    const downloaded = Buffer.from(await downloadRes.arrayBuffer());
    assert.ok(content.equals(downloaded), 'downloaded bytes match uploaded bytes');

    // Verify deviceAttachmentUploadNotify event propagation.
    let received: unknown;
    const unsubscribe = onDeviceAttachmentUpload((ev) => {
      received = ev;
    });
    const notify = {
      type: 'deviceAttachmentUploadNotify' as const,
      id: 'notify-1',
      timestamp: Date.now(),
      targetEventId: 'event-1',
      path: '/workspace/hello.txt',
      status: 'done' as const,
      url: fileUrl,
      contentType: 'text/plain',
      contentLength: content.length,
    };
    emitDeviceAttachmentUpload(notify);
    unsubscribe();
    assert.deepStrictEqual(received, notify, 'deviceAttachmentUploadNotify event propagated');

    console.log('src/upload round-trip test passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
