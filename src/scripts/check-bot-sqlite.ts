/** Actual SQLite transaction/persistence capability of the production sandbox.
 * Hand-written service fixture, not evidence of autonomous model generation. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BackendSandbox } from "../agent/backendSandbox.js";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-sqlite-"));
fs.writeFileSync(path.join(workspace, "server.mjs"), `
import http from 'node:http'; import {DatabaseSync} from 'node:sqlite';
let db=new DatabaseSync('/tmp/inventory.sqlite');
db.exec('CREATE TABLE stock (sku TEXT PRIMARY KEY, quantity INTEGER NOT NULL CHECK(quantity>=0)); CREATE TABLE audit (sku TEXT, delta INTEGER)');
db.prepare('INSERT INTO stock VALUES (?,?)').run('book',10);
http.createServer(async(q,r)=>{try{
 const u=new URL(q.url,'http://localhost');r.setHeader('content-type','application/json');
 if(u.pathname==='/reopen'&&q.method==='POST'){db.close();db=new DatabaseSync('/tmp/inventory.sqlite');r.end('{}');return}
 if(u.pathname==='/stock'&&q.method==='GET'){r.end(JSON.stringify({rows:db.prepare('SELECT * FROM stock ORDER BY sku').all(),audit:db.prepare('SELECT COUNT(*) AS n FROM audit').get().n}));return}
 if(u.pathname==='/withdraw'&&q.method==='POST'){
  let raw='';for await(const part of q)raw+=part;const {sku,amount}=JSON.parse(raw);
  if(typeof sku!=='string'||!Number.isInteger(amount)||amount<=0){r.statusCode=400;r.end('{}');return}
  db.exec('BEGIN IMMEDIATE');
  try{db.prepare('INSERT INTO audit VALUES (?,?)').run(sku,-amount);
   const row=db.prepare('SELECT quantity FROM stock WHERE sku=?').get(sku);
   if(!row||row.quantity<amount)throw Error('insufficient');
   db.prepare('UPDATE stock SET quantity=quantity-? WHERE sku=?').run(amount,sku);
   db.exec('COMMIT');r.end('{}');
  }catch{db.exec('ROLLBACK');r.statusCode=409;r.end('{}')}
  return
 }
 r.statusCode=404;r.end('{}')
}catch(e){r.statusCode=500;r.end(JSON.stringify({error:String(e)}))}}).listen(3000,'127.0.0.1');
`);
const sandbox = await BackendSandbox.start(workspace, "server.mjs");
let id = "", derivedImage = "";
const observations: unknown[] = [];
try {
  const state = await sandbox.inspect() as { Id: string; Image: string }; id = state.Id; derivedImage = state.Image;
  const read = async () => JSON.parse(Buffer.from((await sandbox.request("/stock")).body, "base64").toString());
  const withdraw = (sku: string, amount: number) => sandbox.request("/withdraw", "POST", { "content-type": "application/json" }, Buffer.from(JSON.stringify({ sku, amount })).toString("base64"));
  assert.deepEqual(await read(), { rows: [{ sku: "book", quantity: 10 }], audit: 0 });
  assert.equal((await withdraw("book", 3)).status, 200);
  const after = { rows: [{ sku: "book", quantity: 7 }], audit: 1 };
  assert.deepEqual(await read(), after); observations.push(after);
  assert.equal((await withdraw("book", 8)).status, 409);
  assert.deepEqual(await read(), after, "failed transaction rolls back stock AND audit insert");
  assert.equal((await withdraw("book' OR 1=1 --", 1)).status, 409);
  assert.deepEqual(await read(), after, "quoted SKU is data, not SQL");
  assert.equal((await withdraw("book", -1)).status, 400);
  assert.equal((await sandbox.request("/reopen", "POST")).status, 200);
  assert.deepEqual(await read(), after, "closing/reopening actual database preserves committed rows");
  const concurrent = await Promise.all([withdraw("book", 5), withdraw("book", 5)]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  const final = { rows: [{ sku: "book", quantity: 2 }], audit: 2 };
  assert.deepEqual(await read(), final); observations.push(final);
} finally { await sandbox.close(); }
await assert.rejects(promisify(execFile)("docker", ["inspect", id]));
await assert.rejects(promisify(execFile)("docker", ["image", "inspect", derivedImage]));
fs.mkdirSync("docs/evidence", { recursive: true });
fs.writeFileSync("docs/evidence/bot-sqlite.json", JSON.stringify({ at: new Date().toISOString(), workspace, imageId: sandbox.imageId, observations, rollback: true, quotedInput: true, databaseReopen: true, competingWithdrawals: true, cleanup: true, scope: "hand-written API fixture; SQLite in sandbox /tmp; no persistence across container destruction or claim of autonomous generation" }, null, 2));
console.log("PASS actual SQLite: commit, rollback, quoted input, database reopen, competing withdrawals and sandbox cleanup");
