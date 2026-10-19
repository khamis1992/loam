import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDecipheriv } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { MobileLocalServices,readMobileKnowledge } from '../mobile/local-services.js';
import { recordsFixture } from './mobile-records-fixture.js';
export function checkMobileLocalServices() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-local-services-'));
    let service = new MobileLocalServices(root, recordsFixture);
    try {
        assert.equal(service.policy(), 'shared');
        assert.equal(service.scope(), 'shared');
        assert.throws(() => service.mutate('shared', { action: 'values', values: { note: 'lost' } }), /changed/);
        let state = service.mutate('shared', { action: 'values', expectedRevision: 0, values: { note: 'persisted', done: true } });
        assert.equal(state.state.revision, 1);
        assert.throws(() => service.mutate('shared', { action: 'values', expectedRevision: 0, values: { note: 'overwrite' } }), /changed/);
        state = service.mutate('shared', { action: 'values', expectedRevision: 1, values: { another: 'second tab' } });
        assert.equal(state.values.note, 'persisted');
        const invalid = service.mutate('shared', { action: 'records', expectedRevision: 2, mutation: { type: 'save', collectionId: 'projects', values: { name: '' } } });
        assert.ok(invalid.errors.name);
        assert.equal(invalid.state.revision, 2);
        state = service.mutate('shared', { action: 'records', expectedRevision: 2, mutation: { type: 'save', collectionId: 'projects', values: { name: 'Shared work' } } });
        const row = state.state.collections.projects![0]!;
        assert.equal(row.values.name, 'Shared work');
        assert.throws(() => service.mutate('shared', { action: 'import', expectedRevision: 3, state: { version: 1, revision: 0, collections: {} }, values: {} }), /capability/);
        assert.throws(() => service.mutate('shared', { action: 'import', expectedRevision: 3, state: { version: 1, revision: 0, collections: {} }, values: {} }, true), /empty scope/);
        service.close();
        service = new MobileLocalServices(root, recordsFixture);
        assert.equal(service.state('shared').values.note, 'persisted');
        assert.equal(service.state('shared').state.collections.projects![0]!.values.name, 'Shared work');
        const alice = service.auth({ action: 'register', email: 'ALICE@example.test', password: 'Local-password-123' }) as any;
        const bob = service.auth({ action: 'register', email: 'bob@example.test', password: 'Other-password-123' }) as any;
        assert.equal(alice.user.email, 'alice@example.test');
        assert.equal(service.user(alice.token)?.id, alice.user.id);
        assert.throws(() => service.auth({ action: 'login', email: 'alice@example.test', password: 'incorrect-pass' }), /Invalid email or password/);
        const stored = service.db.prepare('SELECT password FROM users WHERE id=?').get(alice.user.id) as any;
        assert.ok(!stored.password.includes('Local-password'));
        assert.ok(!JSON.stringify(service.summary()).includes(alice.token));
        service.setPolicy({ policy: 'owner' });
        assert.throws(() => service.scope(), /Sign in/);
        assert.equal(service.scope(alice.token), alice.user.id);
        assert.equal(service.state(alice.user.id).state.revision, 0, 'Shared data is not silently assigned to new users');
        const owned = service.mutate(alice.user.id, { action: 'records', expectedRevision: 0, mutation: { type: 'save', collectionId: 'projects', values: { name: 'Alice only' } } });
        assert.equal(service.state(bob.user.id).state.collections.projects, undefined);
        const aliceRow = owned.state.collections.projects![0]!;
        assert.throws(() => service.mutate(bob.user.id, { action: 'records', expectedRevision: 0, mutation: { type: 'save', collectionId: 'projects', id: aliceRow.id, expectedUpdatedAt: aliceRow.updatedAt, values: { name: 'steal' } } }), /متاح/);
        const upload = service.mutateFile(alice.user.id, { action: 'upload', name: 'hello.txt', type: 'text/plain', data: Buffer.from('Hello local storage').toString('base64') }) as any;
        assert.equal(service.file(alice.user.id, upload.file.id).bytes.toString(), 'Hello local storage');
        assert.equal(service.fileList(bob.user.id).length, 0);
        assert.throws(() => service.file(bob.user.id, upload.file.id), /not found/);
        assert.throws(() => service.file(alice.user.id, '../services.sqlite'), /Invalid file id/);
        assert.throws(() => service.mutateFile(alice.user.id, { action: 'upload', name: '../oops', data: 'YQ==' }), /Invalid filename/);
        assert.throws(() => service.mutateFile(alice.user.id, { action: 'upload', name: 'big', data: Buffer.alloc(2000001).toString('base64') }), /2 MB/);
        assert.throws(() => service.mutateFile(bob.user.id, { action: 'delete', id: upload.file.id }), /not found/);
        service.secret({ action: 'set', name: 'API_KEY', value: 'private-secret-never-return' });
        assert.equal(readMobileKnowledge(root),'');
        service.saveKnowledge({text:'Prefer Arabic labels and concise project names.'});
        assert.equal(readMobileKnowledge(root),'Prefer Arabic labels and concise project names.');
        assert.throws(()=>service.saveKnowledge({text:'x'.repeat(16001)}),/16000/);
        assert.equal(service.summary().knowledge.chars,47);
        assert.ok(!JSON.stringify(service.summary().knowledge).includes('Arabic labels'));
        const analytics=service.summary().analytics;assert.equal(analytics.records,2);assert.equal(analytics.users,2);assert.equal(analytics.files,1);assert.equal(analytics.fileBytes,19);assert.ok(analytics.operations.some(row=>row.event==='records.save'&&Number(row.count)===2));assert.ok(analytics.activity.length);assert.ok(!('visitors' in analytics));
        const secret = service.db.prepare('SELECT cipher FROM secrets WHERE name=?').get('API_KEY') as any;
        assert.ok(!secret.cipher.includes('private-secret'));
        const encoded = JSON.parse(secret.cipher), decipher = createDecipheriv('aes-256-gcm', fs.readFileSync(path.join(root, '.loam/mobile-local/secrets.key')), Buffer.from(encoded.iv, 'hex'));
        decipher.setAAD(Buffer.from('API_KEY'));
        decipher.setAuthTag(Buffer.from(encoded.tag, 'hex'));
        assert.equal(Buffer.concat([decipher.update(Buffer.from(encoded.data, 'hex')), decipher.final()]).toString(), 'private-secret-never-return');
        assert.ok(!JSON.stringify(service.summary()).includes('private-secret'));
        assert.ok(!JSON.stringify(service.summary()).includes(stored.password));
        service.db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(alice.user.id);
        assert.throws(() => service.user(alice.token), /expired/);
        const renewed = service.auth({ action: 'login', email: 'alice@example.test', password: 'Local-password-123' }) as any;
        service.manageUser({ action: 'revoke', userId: alice.user.id });
        assert.throws(() => service.user(renewed.token), /revoked/);
        service.manageUser({ action: 'disable', userId: bob.user.id });
        assert.throws(() => service.user(bob.token), /revoked/);
        assert.throws(() => service.auth({ action: 'login', email: 'bob@example.test', password: 'Other-password-123' }), /Invalid/);
        service.manageUser({ action: 'enable', userId: bob.user.id });
        const enabled = service.auth({ action: 'login', email: 'bob@example.test', password: 'Other-password-123' }) as any;
        service.auth({ action: 'logout' }, enabled.token);
        assert.throws(() => service.user(enabled.token), /revoked/);
        for (let i = 0; i < 10; i++)
            try {
                service.auth({ action: 'login', email: 'missing@example.test', password: 'invalid-password' }, undefined, 'throttle-test');
            }
            catch { /* credential failures count */ }
        assert.throws(() => service.auth({ action: 'login', email: 'missing@example.test', password: 'invalid-password' }, undefined, 'throttle-test'), /Too many/);
        service.close();
        service = new MobileLocalServices(root, recordsFixture);
        assert.equal(service.policy(), 'owner');
        assert.equal(service.file(alice.user.id, upload.file.id).bytes.toString(), 'Hello local storage');
        assert.equal(service.summary().secrets.length, 1);
        assert.equal(service.summary().migration, 1);
        assert.equal(service.knowledge().text,'Prefer Arabic labels and concise project names.');
        assert.equal(readMobileKnowledge(root),'Prefer Arabic labels and concise project names.');
        assert.ok(!readMobileKnowledge(root).includes('private-secret'));
        console.log('PASS local SQLite services: persisted values/CAS/records, explicit import, password hashing, auth/session expiry/revoke/disable/throttle, owner isolation, bounded files, encrypted redacted secrets and audit');
    }
    finally {
        service.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
}
/** Run against the real Loam handler, in the caller-owned acceptance-test server. */
export async function checkMobileLocalServicesHTTP(base: string) {
    const request = async (route: string, body?: unknown, extra: Record<string, string> = {}) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const draft = await (await request('/api/tasks/draft', { mode: 'build', title: 'Local services acceptance' })).json() as any;
    const taskId = draft.task.id;
    assert.equal((await request('/api/mobile', { taskId, expectedRevision: 0, project: recordsFixture })).status, 200);
    const prefix = '/api/mobile/local/', query = '?taskId=' + taskId;
    assert.equal((await request(prefix + 'admin' + query)).status, 403);
    const capability = (await (await request(prefix + 'admin' + query, undefined, { 'x-loam-mobile-admin': '1' })).json() as any).capability;
    assert.ok(capability);
    const admin = { 'x-loam-mobile-capability': capability };
    assert.equal((await request(prefix + 'admin/summary' + query)).status, 403);
    assert.equal((await request(prefix + 'admin/summary' + query, undefined, { ...admin, origin: 'https://foreign.example' })).status, 403);
    const summary = await (await request(prefix + 'admin/summary' + query, undefined, admin)).json() as any;
    assert.equal(summary.policy, 'shared');
    assert.equal(summary.migration, 1);
    assert.equal((await request(prefix+'admin/knowledge',{taskId,text:'Arabic-first project content'},admin)).status,200);
    assert.equal((await(await request(prefix+'admin/knowledge'+query,undefined,admin)).json() as any).text,'Arabic-first project content');
    assert.equal((await request(prefix+'admin/knowledge',{taskId,text:'x'.repeat(16001)},admin)).status,400);
    const imported = await request(prefix + 'admin/state', { taskId, action: 'import', expectedRevision: 0, state: { version: 1, revision: 0, collections: {} }, values: { note: 'Explicit old browser data' } }, admin);
    assert.equal(imported.status, 200);
    assert.equal((await request(prefix + 'admin/state', { taskId, action: 'import', expectedRevision: 1, values: {} }, admin)).status, 409);
    const state = await (await request(prefix + 'state' + query)).json() as any;
    assert.equal(state.values.note, 'Explicit old browser data');
    assert.equal((await request(prefix + 'state', { taskId, action: 'values', expectedRevision: 0, values: { note: 'stale' } })).status, 409);
    const alice = await (await request(prefix + 'auth', { taskId, action: 'register', email: 'alice@example.test', password: 'Alice-password-123' })).json() as any;
    const bob = await (await request(prefix + 'auth', { taskId, action: 'register', email: 'bob@example.test', password: 'Bob-password-123' })).json() as any;
    const a = { authorization: 'Bearer ' + alice.token }, b = { authorization: 'Bearer ' + bob.token };
    assert.ok(alice.user.id);
    await request(prefix + 'admin/policy', { taskId, policy: 'owner' }, admin);
    assert.equal((await request(prefix + 'state' + query)).status, 401);
    const saved = await (await request(prefix + 'functions', { taskId, name: 'records.save', collectionId: 'projects', values: { name: 'Owner scoped' }, expectedRevision: 0 }, a)).json() as any;
    assert.equal(saved.state.collections.projects.length, 1);
    assert.equal((await request(prefix + 'functions', { taskId, name: 'eval', code: 'process.exit()' }, a)).status, 400);
    const bobList = await (await request(prefix + 'functions', { taskId, name: 'records.list', collectionId: 'projects' }, b)).json() as any;
    assert.deepEqual(bobList.records, []);
    const file = await (await request(prefix + 'files', { taskId, action: 'upload', name: 'note.txt', type: 'text/plain', data: 'bG9jYWw=' }, a)).json() as any;
    assert.ok(file.file.id);
    assert.equal(await (await request(prefix + 'files' + query + '&id=' + file.file.id, undefined, a)).text(), 'local');
    assert.equal((await request(prefix + 'files' + query + '&id=' + file.file.id, undefined, b)).status, 404);
    await request(prefix + 'admin/secrets', { taskId, action: 'set', name: 'TEST_SECRET', value: 'never-in-summary' }, admin);
    assert.ok(!(await (await request(prefix + 'admin/summary' + query, undefined, admin)).text()).includes('never-in-summary'));
    await request(prefix + 'admin/users', { taskId, action: 'revoke', userId: alice.user.id }, admin);
    assert.equal((await request(prefix + 'state' + query, undefined, a)).status, 401);
    console.log('PASS local services HTTP: explicit studio capability, origin/method separation, migration, public auth, owner records/functions/files, redacted secrets and revocation');
    return { taskId };
}
async function isolatedHTTP() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-local-http-')), workspace = path.join(temp, 'workspace'), config = path.join(temp, 'config.json');
    fs.mkdirSync(workspace);
    fs.writeFileSync(config, JSON.stringify({ model: 'fixture', workspace, computerUse: { enabled: false, screenshotDir: path.join(temp, 'screenshots') }, memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, mcpServers: {} }));
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as import('node:net').AddressInfo).port;
    await new Promise<void>(r => probe.close(() => r()));
    const base = 'http://127.0.0.1:' + port, child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: path.join(temp, 'data'), MANUS_LOCAL_PORT: String(port), MANUS_LOCAL_EVALS_DIR: path.join(temp, 'evals'), MANUS_LOCAL_SKILLS_DIR: path.join(temp, 'skills') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    child.stdout.on('data', chunk => logs += chunk);
    child.stderr.on('data', chunk => logs += chunk);
    try {
        let ready = false;
        const until = Date.now() + 30000;
        while (Date.now() < until) {
            if (await fetch(base + '/api/tasks').then(r => r.ok).catch(() => false)) {
                ready = true;
                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }
        assert.ok(ready, logs);
        await checkMobileLocalServicesHTTP(base);
    }
    finally {
        if (child.exitCode === null) {
            const ended = once(child, 'exit');
            child.kill();
            await ended;
        }
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    checkMobileLocalServices();
    if (process.argv.includes('--http'))
        await isolatedHTTP();
}
