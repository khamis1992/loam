import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getPresignedUploadUrl,
  putFile,
  uploadComplete,
  uploadFile,
} from './upload.js';

describe('upload client service', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(_input);
        if (url.endsWith('/api/chat/getPresignedUploadUrl')) {
          return new Response(JSON.stringify({ data: { uploadUrl: 'http://x/blob/abc', id: 'abc' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/api/chat/uploadComplete')) {
          return new Response(JSON.stringify({ data: { fileUrl: 'http://x/blob/abc' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url === 'http://x/blob/abc') {
          return new Response(null, { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('gets a presigned upload URL', async () => {
    const res = await getPresignedUploadUrl('http://x', {
      filename: 'f.txt',
      fileType: 'text/plain',
      fileSize: 5,
    });
    expect(res.data.id).toBe('abc');
    expect(res.data.uploadUrl).toBe('http://x/blob/abc');
  });

  it('PUTs a blob', async () => {
    await putFile('http://x/blob/abc', new Blob(['hello']), 'text/plain');
    expect(fetch).toHaveBeenCalledWith(
      'http://x/blob/abc',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('completes the upload', async () => {
    const res = await uploadComplete('http://x', { filename: 'f.txt', fileSize: 5, id: 'abc' });
    expect(res.data.fileUrl).toBe('http://x/blob/abc');
  });

  it('uploads a file end-to-end and returns a spec attachment', async () => {
    const file = new File(['hello'], 'f.txt', { type: 'text/plain' });
    const attachment = await uploadFile('http://x', file);

    expect(attachment.type).toBe('file');
    expect(attachment.filename).toBe('f.txt');
    expect(attachment.url).toBe('http://x/blob/abc');
    expect(attachment.id).toMatch(/^temp-/);
    expect(attachment.fileMetaData).toEqual({
      tag: 'upload',
      uploadStatus: 'success',
      uploadProgress: 100,
    });

    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
