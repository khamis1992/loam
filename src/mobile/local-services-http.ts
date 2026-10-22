import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getTask } from '../server/db.js';
import { requireTaskWorkspace } from '../server/taskWorkspace.js';
import { MobileError, readMobile } from './store.js';
import { MobileLocalServices } from './local-services.js';
const capabilities = new Map<string, {
    value: string;
    expires: number;
}>();
function sameOrigin(req: IncomingMessage) { if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site')
    throw new MobileError('Same-origin requests required', 403); }
function administrator(req: IncomingMessage, taskId: string) { const supplied = req.headers['x-loam-mobile-capability'], stored = capabilities.get(taskId); if (typeof supplied !== 'string' || !stored || stored.expires < Date.now() || supplied.length !== stored.value.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(stored.value)))
    throw new MobileError('Studio capability required', 403); }
const json = (res: ServerResponse, data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data)); };
export async function handleMobileLocalServices(req: IncomingMessage, res: ServerResponse, url: URL, workspace: string): Promise<boolean> {
    if (!url.pathname.startsWith('/api/mobile/local/'))
        return false;
    let service: MobileLocalServices | undefined;
    try {
        sameOrigin(req);
        if (!['GET', 'POST'].includes(req.method ?? ''))
            throw new MobileError('GET or POST required', 405);
        let body: Record<string, any> = {};
        if (req.method === 'POST') {
            if (!req.headers['content-type']?.startsWith('application/json'))
                throw new MobileError('JSON required', 415);
            let size = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += bytes.length;
                if (size > 3500000)
                    throw new MobileError('Body too large', 413);
                chunks.push(bytes);
            }
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            }
            catch {
                throw new MobileError('Invalid JSON');
            }
            if (!body || typeof body !== 'object' || Array.isArray(body))
                throw new MobileError('Expected object');
        }
        const taskId = body.taskId ?? url.searchParams.get('taskId');
        if (typeof taskId !== 'string' || !taskId)
            throw new MobileError('taskId required');
        const task = getTask(taskId);
        if (!task)
            throw new MobileError('Task not found', 404);
        if (task.mode !== 'build')
            throw new MobileError('Build task required', 403);
        const root = requireTaskWorkspace(taskId, workspace), project = readMobile(root);
        if (!project)
            throw new MobileError('Save a mobile project first', 404);
        const route = url.pathname.slice('/api/mobile/local/'.length), post = req.method === 'POST';
        if (route === 'admin') {
            if (post)
                throw new MobileError('GET required', 405);
            if (req.headers['x-loam-mobile-admin'] !== '1')
                throw new MobileError('Explicit studio request required', 403);
            // A capability is only delivered to the trusted same-origin host, never the opaque app.
            for (const [id, value] of capabilities)
                if (value.expires < Date.now())
                    capabilities.delete(id);
            if (capabilities.size >= 500 && !capabilities.has(taskId))
                throw new MobileError('Too many active studio capabilities', 429);
            let entry = capabilities.get(taskId);
            if (!entry || entry.expires < Date.now()) {
                entry = { value: randomBytes(32).toString('base64url'), expires: Date.now() + 3600000 };
                capabilities.set(taskId, entry);
            }
            json(res, { capability: entry.value, expiresAt: new Date(entry.expires).toISOString() });
            return true;
        }
        const admin = route.startsWith('admin/');
        if (admin)
            administrator(req, taskId);
        const auth = req.headers.authorization;
        const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
        if (token && token.length > 200)
            throw new MobileError('Invalid bearer token', 401);
        service = new MobileLocalServices(root, project);
        if (route === 'auth')
            json(res, post ? service.auth(body, token, req.socket.remoteAddress ?? 'local') : { user: service.user(token) });
        else if (route === 'state' || route === 'admin/state') {
            const scope = admin ? String(body.scope ?? url.searchParams.get('scope') ?? 'shared') : service.scope(token);
            if (scope !== 'shared' && !service.db.prepare('SELECT id FROM users WHERE id=?').get(scope))
                throw new MobileError('User scope not found', 404);
            json(res, post ? service.mutate(scope, body, admin) : service.state(scope));
        }
        else if (route === 'files' || route === 'admin/files') {
            const scope = admin ? 'shared' : service.scope(token);
            if (post)
                json(res, service.mutateFile(scope, body, admin));
            else if (url.searchParams.has('id')) {
                const file = service.file(admin ? undefined : scope, url.searchParams.get('id'));
                res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name), 'content-length': file.bytes.length, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
                res.end(file.bytes);
            }
            else
                json(res, { files: service.fileList(admin ? undefined : scope) });
        }
        else if (route === 'functions') {
            if (!post)
                throw new MobileError('POST required', 405);
            const scope = service.scope(token);
            if (body.name === 'records.list') {
                json(res,service.listRecords(scope,body.collectionId));
            }
            else if (['records.save', 'records.delete', 'records.restore'].includes(body.name)) {
                json(res, service.mutate(scope, { action: 'records', expectedRevision: body.expectedRevision, mutation: { type: body.name.split('.')[1], collectionId: body.collectionId, id: body.id, values: body.values, expectedUpdatedAt: body.expectedUpdatedAt } }));
            }
            else
                throw new MobileError('Only validated named record operations are supported');
        }
        else if (route === 'admin/summary' && !post)
            json(res, service.summary());
        else if (route === 'admin/users' && post)
            json(res, service.manageUser(body));
        else if (route === 'admin/policy' && post)
            json(res, service.setPolicy(body));
        else if (route === 'admin/secrets' && post)
            json(res, service.secret(body));
        else if (route === 'admin/knowledge')
            json(res, post ? service.saveKnowledge(body) : service.knowledge());
        else
            throw new MobileError('Local service route or method not found', 404);
    }
    catch (e) {
        json(res, { error: e instanceof MobileError ? e.message : 'Local service operation failed' }, e instanceof MobileError ? e.status : 400);
    }
    finally {
        service?.close();
    }
    return true;
}
