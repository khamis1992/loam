import http from 'node:http';
import type { UploadConfig } from './types.js';
import { createUploadRoutes } from './router.js';

export * from './types.js';
export { FileStore } from './store.js';
export { createUploadRoutes } from './router.js';
export { onDeviceAttachmentUpload, emitDeviceAttachmentUpload } from './events.js';

export function createUploadServer(config: UploadConfig): http.Server {
  const routes = createUploadRoutes(config);

  const server = http.createServer(async (req, res) => {
    // Minimal CORS for dev/test callers.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = req.url ?? '/';

    if (req.method === 'POST' && url === '/api/chat/getPresignedUploadUrl') {
      await routes.getPresignedUploadUrl(req, res);
      return;
    }
    if (req.method === 'POST' && url === '/api/chat/uploadComplete') {
      await routes.uploadComplete(req, res);
      return;
    }
    const blobMatch = /^\/blob\/([a-f0-9]+)$/.exec(url);
    if (blobMatch) {
      const id = blobMatch[1]!;
      if (req.method === 'PUT') {
        await routes.putBlob(req, res, id);
        return;
      }
      if (req.method === 'GET') {
        await routes.getBlob(req, res, id);
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'not_found', message: 'unsupported upload route' }));
  });

  return server;
}
