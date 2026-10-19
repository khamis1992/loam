import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UploadConfig, PresignRequest, CompleteRequest } from './types.js';
import { FileStore } from './store.js';

export interface RouteHandlers {
  store: FileStore;
  getPresignedUploadUrl: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  uploadComplete: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  putBlob: (req: IncomingMessage, res: ServerResponse, id: string) => Promise<void>;
  getBlob: (req: IncomingMessage, res: ServerResponse, id: string) => Promise<void>;
}

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

export function createUploadRoutes(config: UploadConfig): RouteHandlers {
  const store = new FileStore(config.storageDir);
  const getBaseUrl = () =>
    (typeof config.baseUrl === 'function' ? config.baseUrl() : config.baseUrl).replace(/\/$/, '');

  const getPresignedUploadUrl = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readJson<PresignRequest>(req);
    const { id } = store.reserve(body);
    sendJson(res, 200, { data: { uploadUrl: `${getBaseUrl()}/blob/${id}`, id } });
  };

  const uploadComplete = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readJson<CompleteRequest>(req);
    try {
      const stored = store.complete(body);
      sendJson(res, 200, { data: { fileUrl: `${getBaseUrl()}/blob/${stored.id}` } });
    } catch (e) {
      sendJson(res, 400, { code: 'invalid_argument', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const putBlob = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    try {
      const data = await readRaw(req);
      store.save(id, data);
      res.writeHead(200).end();
    } catch (e) {
      sendJson(res, 400, { code: 'invalid_argument', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const getBlob = async (_req: IncomingMessage, res: ServerResponse, id: string) => {
    const buf = store.getBuffer(id);
    if (!buf) {
      sendJson(res, 404, { code: 'not_found', message: 'blob not found' });
      return;
    }
    const f = store.get(id);
    res.writeHead(200, {
      'content-type': f?.contentType ?? 'application/octet-stream',
      'content-length': buf.length,
    });
    res.end(buf);
  };

  return { store, getPresignedUploadUrl, uploadComplete, putBlob, getBlob };
}
