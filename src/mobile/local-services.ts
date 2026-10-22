import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash, createCipheriv } from 'node:crypto';
import { taskPath } from '../server/taskWorkspace.js';
import { MobileError, type MobileProject } from './store.js';
import { mutateRecords, parseRecordState, validateRecord, type RecordState } from '../../ui/mobile-data.js';
type Row = Record<string, any>;
export type LocalUser = {
    id: string;
    email: string;
    disabled: boolean;
    createdAt: string;
};
export type LocalState = {
    state: RecordState;
    values: Record<string, string | boolean | number>;
    policy: 'shared' | 'owner';
};
const empty = (): RecordState => ({ version: 1, revision: 0, collections: {} });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const bad = (message: string, status = 400): never => { throw new MobileError(message, status); };
function object(v: unknown): Record<string, any> { if (!v || typeof v !== 'object' || Array.isArray(v))
    return bad('Expected object'); return v as Record<string, any>; }
function bounded(v: unknown, max: number, label: string) { if (typeof v !== 'string' || !v.trim() || v.length > max)
    return bad('Invalid ' + label); return v; }
function publicUser(row: Row): LocalUser { return { id: row.id, email: row.email, disabled: !!row.disabled, createdAt: row.created_at }; }
/** One synchronous SQLite transaction protects each scoped mutation. No app-supplied SQL is run. */
export class MobileLocalServices {
    readonly db: DatabaseSync;
    constructor(readonly root: string, readonly project: MobileProject) {
        fs.mkdirSync(taskPath(root, '.loam/mobile-local'), { recursive: true });
        for (const suffix of ['-wal', '-shm', '-journal'])
            taskPath(root, '.loam/mobile-local/services.sqlite' + suffix);
        this.db = new DatabaseSync(taskPath(root, '.loam/mobile-local/services.sqlite'));
        try {
            fs.chmodSync(taskPath(root, '.loam/mobile-local'), 0o700);
            fs.chmodSync(taskPath(root, '.loam/mobile-local/services.sqlite'), 0o600);
        }
        catch { /* Windows uses the workspace ACL. */ }
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS states(scope TEXT PRIMARY KEY,records TEXT NOT NULL,app_values TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS secrets(name TEXT PRIMARY KEY,cipher TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,detail TEXT NOT NULL);
   INSERT OR IGNORE INTO settings VALUES('policy','shared');
   INSERT OR IGNORE INTO migrations VALUES(1,datetime('now'));`);
    }
    close() { this.db.close(); }
    private tx<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try {
        const value = fn();
        this.db.exec('COMMIT');
        return value;
    }
    catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
    } }
    policy() { return (this.db.prepare("SELECT value FROM settings WHERE key='policy'").get() as Row).value as 'shared' | 'owner'; }
    private audit(event: string, actor: string, detail = '') { this.db.prepare('INSERT INTO audit(event,actor,at,detail) VALUES(?,?,?,?)').run(event, actor, new Date().toISOString(), detail.slice(0, 300)); this.db.exec('DELETE FROM audit WHERE id < (SELECT COALESCE(MAX(id),0)-1000 FROM audit)'); }
    user(token?: string): LocalUser | null {
        if (!token)
            return null;
        const row = this.db.prepare('SELECT u.* FROM sessions s JOIN users u ON s.user_id=u.id WHERE token_hash=? AND expires_at>? AND u.disabled=0').get(hash(token), Date.now()) as Row | undefined;
        if (!row)
            return bad('Session expired or revoked', 401);
        return publicUser(row);
    }
    scope(token?: string) { const user = this.user(token); if (this.policy() === 'owner') {
        if (!user)
            return bad('Sign in required', 401);
        return user.id;
    } return 'shared'; }
    state(scope: string): LocalState { const row = this.db.prepare('SELECT * FROM states WHERE scope=?').get(scope) as Row | undefined; return { state: row ? parseRecordState(row.records) : empty(), values: row ? JSON.parse(row.app_values) : {}, policy: this.policy() }; }
    private write(scope: string, value: LocalState) { if (Buffer.byteLength(JSON.stringify(value)) > 3000000)
        return bad('App data exceeds 3 MB', 413); this.db.prepare('INSERT INTO states VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET records=excluded.records,app_values=excluded.app_values').run(scope, JSON.stringify(value.state), JSON.stringify(value.values)); }
    private values(input: unknown) { const obj = object(input), clean: Record<string, string | boolean | number> = {}; if (Object.keys(obj).length > 2000 || Buffer.byteLength(JSON.stringify(obj)) > 250000)
        return bad('App values exceed limit', 413); for (const [key, v] of Object.entries(obj)) {
        if (!/^[a-z][a-z\d_-]{0,79}$/i.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) || !['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'string' && v.length > 10000) || (typeof v === 'number' && !Number.isFinite(v)))
            return bad('Invalid app value');
        clean[key] = v as string | boolean | number;
    } return clean; }
    mutate(scope: string, input: unknown, admin = false) {
        const body = object(input);
        return this.tx(() => {
            const current = this.state(scope);
            if (body.expectedRevision !== current.state.revision)
                return bad('App data changed; reload before saving', 409);
            let errors: Record<string, string> = {};
            if (body.action === 'records') {
                const mutation = object(body.mutation);
                if (!['save', 'delete', 'restore'].includes(mutation.type) || typeof mutation.collectionId !== 'string')
                    return bad('Invalid record operation');
                if (mutation.type === 'save')
                    object(mutation.values);
                let result: ReturnType<typeof mutateRecords>;
                try {
                    result = mutateRecords(current.state, this.project.collections || [], mutation as Parameters<typeof mutateRecords>[2]);
                }
                catch (e) {
                    throw new MobileError(e instanceof Error ? e.message : 'Invalid record operation');
                }
                current.state = result.state;
                errors = result.errors;
            }
            else if (body.action === 'values') {
                current.values = { ...current.values, ...this.values(body.values) };
                current.state.revision++;
            }
            else if (body.action === 'import') {
                if (!admin)
                    return bad('Import requires studio capability', 403);
                if (current.state.revision !== 0 || Object.keys(current.values).length || Object.values(current.state.collections).some(rows => rows.length))
                    return bad('Import requires an empty scope; existing data is preserved', 409);
                const incoming = parseRecordState(JSON.stringify(body.state ?? empty()));
                let count = 0;
                for (const [id, rows] of Object.entries(incoming.collections)) {
                    const schema = this.project.collections?.find(c => c.id === id);
                    if (!schema || rows.length > 1000)
                        return bad('Invalid imported collection');
                    for (const row of rows) {
                        count++;
                        if (!/^[\w-]{1,100}$/.test(row.id) || !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(row.updatedAt)))
                            return bad('Invalid imported record');
                        const checked = validateRecord(schema, row.values, incoming, row.id);
                        if (Object.keys(checked.errors).length)
                            return bad('Imported records do not match schema');
                        row.values = checked.values;
                    }
                }
                if (count > 16000)
                    return bad('Too many records');
                current.state = incoming;
                current.state.revision = 1;
                current.values = this.values(body.values ?? {});
            }
            else
                return bad('Unknown state action');
            if (!Object.keys(errors).length) {
                this.write(scope, current);
                this.audit(body.action === 'records' ? 'records.' + body.mutation.type : body.action, scope);
            }
            return { ...current, errors };
        });
    }
    private throttle(key: string, limit: number) { const now = Date.now(), row = this.db.prepare('SELECT * FROM attempts WHERE key=?').get(key) as Row | undefined; if (row && row.until_at > now && row.count >= limit)
        return bad('Too many attempts; retry in one minute', 429); this.db.prepare('INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN until_at<=? THEN 1 ELSE count+1 END,until_at=CASE WHEN until_at<=? THEN ? ELSE until_at END').run(key, now + 60000, now, now, now + 60000); this.db.prepare('DELETE FROM attempts WHERE until_at<?').run(now - 60000); }
    auth(input: unknown, token?: string, client = 'local') {
        const body = object(input);
        if (body.action === 'logout') {
            if (token)
                this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
            return { ok: true };
        }
        if (!['register', 'login'].includes(body.action))
            return bad('Unknown auth action');
        const email = bounded(body.email, 254, 'email').trim().toLowerCase(), password = bounded(body.password, 200, 'password');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            return bad('Invalid email');
        this.throttle('client:' + hash(client), 30);
        this.throttle('email:' + hash(email), 10);
        if (body.action === 'register') {
            if (password.length < 10)
                return bad('Password needs at least 10 characters');
            if ((this.db.prepare('SELECT count(*) AS n FROM users').get() as Row).n >= 200)
                return bad('Local user limit reached', 413);
            if (this.db.prepare('SELECT id FROM users WHERE email=?').get(email))
                return bad('Unable to register this account', 409);
            const salt = randomBytes(16).toString('hex'), encoded = salt + ':' + scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex'), id = randomUUID();
            this.db.prepare('INSERT INTO users(id,email,password,created_at) VALUES(?,?,?,?)').run(id, email, encoded, new Date().toISOString());
            this.audit('auth.register', id);
        }
        const row = this.db.prepare('SELECT * FROM users WHERE email=?').get(email) as Row | undefined;
        // Run the same KDF on missing accounts to keep the credential failure path comparable.
        const [salt, digest] = (row?.password ?? '00000000000000000000000000000000:' + ''.padStart(64, '0')).split(':');
        const checked = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }), valid = timingSafeEqual(checked, Buffer.from(digest, 'hex'));
        if (!row || row.disabled || !valid)
            return bad('Invalid email or password', 401);
        const issued = randomBytes(32).toString('base64url'), expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
        this.db.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT -1 OFFSET 9)').run(row.id);
        this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(issued), row.id, expiresAt);
        this.audit('auth.login', row.id);
        return { token: issued, user: publicUser(row), expiresAt: new Date(expiresAt).toISOString() };
    }
    manageUser(input: unknown) { const b = object(input); if (!['disable', 'enable', 'revoke'].includes(b.action) || typeof b.userId !== 'string')
        return bad('Invalid user action'); if (!this.db.prepare('SELECT id FROM users WHERE id=?').get(b.userId))
        return bad('User not found', 404); return this.tx(() => { if (b.action !== 'revoke')
        this.db.prepare('UPDATE users SET disabled=? WHERE id=?').run(b.action === 'disable' ? 1 : 0, b.userId); if (b.action !== 'enable')
        this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(b.userId); this.audit('user.' + b.action, 'studio', b.userId); return { ok: true }; }); }
    setPolicy(input: unknown) { const b = object(input); if (!['shared', 'owner'].includes(b.policy))
        return bad('Invalid policy'); this.db.prepare("UPDATE settings SET value=? WHERE key='policy'").run(b.policy); this.audit('policy.change', 'studio', b.policy); return { policy: this.policy(), note: 'Existing shared data stays in its original scope; no records were reassigned.' }; }
    listRecords(scope:string,collectionId:unknown) {
        if(!this.project.collections?.some(c=>c.id===collectionId))bad('Collection not found',404);
        const current=this.state(scope);this.audit('records.list',scope,String(collectionId));
        return {records:(current.state.collections[String(collectionId)]||[]).filter(r=>!r.deletedAt),revision:current.state.revision};
    }
    fileList(scope?: string) { return this.db.prepare('SELECT * FROM files' + (scope ? ' WHERE owner=?' : '') + ' ORDER BY created_at DESC').all(...(scope ? [scope] : [])).map(row => ({ id: row.id, name: row.name, type: row.type, size: row.size, owner: row.owner, createdAt: row.created_at })); }
    file(scope: string | undefined, id: unknown): Row & {
        id: string;
        name: string;
        bytes: Buffer;
    } { if (typeof id !== 'string' || !/^[-\w]{36}$/.test(id))
        return bad('Invalid file id'); const row = this.db.prepare('SELECT * FROM files WHERE id=?' + (scope ? ' AND owner=?' : '')).get(id, ...(scope ? [scope] : [])) as Row | undefined; if (!row)
        return bad('File not found', 404); const file = taskPath(this.root, '.loam/mobile-local/files/' + id); return { ...row, id: String(row.id), name: String(row.name), bytes: fs.readFileSync(file) }; }
    mutateFile(scope: string, input: unknown, admin = false) {
        const body = object(input);
        if (body.action === 'delete') {
            const row = this.file(admin ? undefined : scope, body.id);
            this.db.prepare('DELETE FROM files WHERE id=?').run(row.id);
            fs.unlinkSync(taskPath(this.root, '.loam/mobile-local/files/' + row.id));
            this.audit('files.delete', scope, row.id);
            return { ok: true };
        }
        if (body.action !== 'upload')
            return bad('Unknown file action');
        const name = bounded(body.name, 160, 'filename');
        if (/[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..')
            return bad('Invalid filename');
        const type = bounded(body.type ?? 'application/octet-stream', 120, 'media type');
        if (!/^[\w.+-]+\/[\w.+-]+$/.test(type))
            return bad('Invalid media type');
        const raw = bounded(body.data, 2800000, 'base64 file');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw))
            return bad('Invalid base64 file');
        const bytes = Buffer.from(raw, 'base64');
        if (bytes.length > 2000000)
            return bad('File exceeds 2 MB', 413);
        const id = randomUUID(), createdAt = new Date().toISOString();
        this.tx(() => { const totals = this.db.prepare('SELECT COALESCE(SUM(size),0) AS size,COUNT(*) AS n FROM files').get() as Row; if (totals.size + bytes.length > 50000000 || totals.n >= 500)
            return bad('Local file quota reached', 413); fs.mkdirSync(taskPath(this.root, '.loam/mobile-local/files'), { recursive: true }); fs.writeFileSync(taskPath(this.root, '.loam/mobile-local/files/' + id), bytes, { flag: 'wx', mode: 0o600 }); try {
            this.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?)').run(id, scope, name, type, bytes.length, createdAt);
            this.audit('files.upload', scope, id);
        }
        catch (e) {
            fs.unlinkSync(taskPath(this.root, '.loam/mobile-local/files/' + id));
            throw e;
        } });
        return { file: { id, name, type, size: bytes.length, owner: scope, createdAt } };
    }
    secret(input: unknown) { const body = object(input), name = bounded(body.name, 80, 'secret name'); if (!/^[A-Z][A-Z0-9_]*$/.test(name))
        return bad('Use an uppercase secret name'); if (body.action === 'delete') {
        this.db.prepare('DELETE FROM secrets WHERE name=?').run(name);
        this.audit('secrets.delete', 'studio', name);
        return { ok: true };
    } if (body.action !== 'set')
        return bad('Unknown secret action'); const value = bounded(body.value, 10000, 'secret value'); const keyFile = taskPath(this.root, '.loam/mobile-local/secrets.key'); if (!fs.existsSync(keyFile))
        fs.writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); try {
        fs.chmodSync(keyFile, 0o600);
    }
    catch { /* Windows ACLs remain inherited from the local workspace. */ } const key = fs.readFileSync(keyFile); if (key.length !== 32)
        return bad('Secret key is invalid', 500); const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(name)); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); this.db.prepare('INSERT INTO secrets VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET cipher=excluded.cipher,updated_at=excluded.updated_at').run(name, JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('hex') }), new Date().toISOString()); this.audit('secrets.set', 'studio', name); return { ok: true }; }
    knowledge() {
        const text=this.db.prepare("SELECT value FROM settings WHERE key='knowledge'").get() as Row|undefined;
        const updated=this.db.prepare("SELECT value FROM settings WHERE key='knowledgeUpdatedAt'").get() as Row|undefined;
        return {text:String(text?.value??''),updatedAt:updated?String(updated.value):null};
    }
    saveKnowledge(input:unknown) {
        const body=object(input);if(typeof body.text!=='string'||body.text.length>16000)bad('Knowledge must contain at most 16000 characters');
        return this.tx(()=>{const at=new Date().toISOString();this.db.prepare("INSERT INTO settings VALUES('knowledge',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(body.text);this.db.prepare("INSERT INTO settings VALUES('knowledgeUpdatedAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(at);this.audit('knowledge.save','studio');return this.knowledge();});
    }
    analytics() {
        const states=this.db.prepare('SELECT records FROM states').all() as Row[],users=this.db.prepare('SELECT COUNT(*) AS total,SUM(CASE WHEN disabled=0 THEN 1 ELSE 0 END) AS active FROM users').get() as Row,files=this.db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(size),0) AS bytes FROM files').get() as Row,window=this.db.prepare('SELECT COUNT(*) AS count,MIN(at) AS first,MAX(at) AS last FROM audit').get() as Row;
        return {records:states.reduce((sum,row)=>sum+Object.values(parseRecordState(row.records).collections).reduce((n,rows)=>n+rows.filter(r=>!r.deletedAt).length,0),0),users:Number(users.total),activeUsers:Number(users.active??0),files:Number(files.total),fileBytes:Number(files.bytes),operations:this.db.prepare('SELECT event,COUNT(*) AS count FROM audit GROUP BY event ORDER BY count DESC,event').all(),activity:this.db.prepare('SELECT substr(at,1,10) AS day,COUNT(*) AS events FROM audit GROUP BY day ORDER BY day').all(),window:{retainedEvents:Number(window.count),from:window.first as string|null,to:window.last as string|null,maxEvents:1001},note:'Local backend audit events only; no visitor tracking'};
    }
    summary() {
        const scopes=this.db.prepare('SELECT scope,records FROM states').all() as Row[],knowledge=this.knowledge();
        return {policy:this.policy(),collections:(this.project.collections||[]).map(c=>({id:c.id,title:c.title,count:scopes.reduce((n,row)=>n+(parseRecordState(row.records).collections[c.id]||[]).filter(r=>!r.deletedAt).length,0)})),users:(this.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as Row[]).map(publicUser),files:this.fileList(),secrets:this.db.prepare('SELECT name,updated_at AS updatedAt FROM secrets ORDER BY name').all(),logs:this.db.prepare('SELECT id,event,actor,at,detail FROM audit ORDER BY id DESC LIMIT 100').all(),operations:['records.list','records.save','records.delete','records.restore'],limits:{fileBytes:2000000,totalFileBytes:50000000,users:200},knowledge:{chars:knowledge.text.length,updatedAt:knowledge.updatedAt},analytics:this.analytics(),migration:1};
    }
}

/** Only project-authored knowledge is provided to generation; records, credentials and secrets never enter it. */
export function readMobileKnowledge(root:string):string {
    const file=taskPath(root,'.loam/mobile-local/services.sqlite');if(!fs.existsSync(file))return '';
    for(const suffix of ['-wal','-shm','-journal'])taskPath(root,'.loam/mobile-local/services.sqlite'+suffix);
    let db:DatabaseSync|undefined;
    try{db=new DatabaseSync(file,{readOnly:true});const row=db.prepare("SELECT value FROM settings WHERE key='knowledge'").get() as Row|undefined;return typeof row?.value==='string'?row.value.slice(0,16000):'';}
    catch{return '';}
    finally{db?.close();}
}
