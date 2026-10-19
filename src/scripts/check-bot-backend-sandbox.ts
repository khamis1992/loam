import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BackendSandbox } from "../agent/backendSandbox.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-backend-check-"));
fs.writeFileSync(path.join(root, ".env"), "PRIVATE_SENTINEL=must-not-copy");
fs.writeFileSync(path.join(root, "server.mjs"), `
import http from 'node:http';import fs from 'node:fs';import net from 'node:net';
http.createServer(async(req,res)=>{try{
 if(req.url==='/probe'){
  const denied={};for(const p of ['/app/escape','/etc/escape']){try{fs.writeFileSync(p,'bad');denied[p]=false}catch{denied[p]=true}}
  const network=await new Promise(resolve=>{const s=net.connect({host:'1.1.1.1',port:80});s.setTimeout(700);s.on('connect',()=>{s.destroy();resolve(true)});s.on('error',()=>resolve(false));s.on('timeout',()=>{s.destroy();resolve(false)})});
  res.end(JSON.stringify({uid:process.getuid(),denied,network,secret:fs.existsSync('/app/.env'),socket:fs.existsSync('/var/run/docker.sock'),host:fs.existsSync('/mnt/c')}));return;
 }
 if(req.url==='/api/count'){
  let n=Number(fs.existsSync('/tmp/count')?fs.readFileSync('/tmp/count','utf8'):0);
  if(req.method==='POST'){n++;fs.writeFileSync('/tmp/count',String(n))}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({count:n}));return;
 }
 res.statusCode=404;res.end('not found');
}catch(e){res.statusCode=500;res.end(String(e))}}).listen(3000,'127.0.0.1');
`);
await assert.rejects(BackendSandbox.start(root, "../escape.mjs"), /Invalid backend entry/);
const sandbox = await BackendSandbox.start(root, "server.mjs");
let evidence: Record<string, unknown> = {};
let containerId = "", sourceImageId = "";
try {
  const state = await sandbox.inspect() as any;
  containerId = state.Id; sourceImageId = state.Image;
  assert.equal(state.HostConfig.NetworkMode, "none");
  assert.equal(state.HostConfig.ReadonlyRootfs, true);
  assert.equal(state.Config.User, "1000:1000");
  assert.deepEqual(state.HostConfig.CapDrop, ["ALL"]);
  assert.ok(state.HostConfig.SecurityOpt.includes("no-new-privileges"));
  assert.equal(state.HostConfig.Memory, 256 * 1024 * 1024);
  assert.equal(state.HostConfig.PidsLimit, 64);
  assert.equal(state.Mounts.length, 0);
  assert.ok(!state.HostConfig.PortBindings || Object.keys(state.HostConfig.PortBindings).length === 0);
  const decode = (r: { body: string }) => JSON.parse(Buffer.from(r.body, "base64").toString());
  assert.deepEqual(decode(await sandbox.request("/api/count")), { count: 0 });
  assert.deepEqual(decode(await sandbox.request("/api/count", "POST")), { count: 1 });
  assert.deepEqual(decode(await sandbox.request("/api/count")), { count: 1 });
  const probe = decode(await sandbox.request("/probe"));
  assert.equal(probe.uid, 1000);
  assert.equal(probe.network, false);
  assert.equal(probe.secret, false);
  assert.equal(probe.socket, false);
  assert.equal(probe.host, false);
  assert.deepEqual(probe.denied, { "/app/escape": true, "/etc/escape": true });
  await assert.rejects(sandbox.request("//example.com"), /Invalid sandbox request/);
  await assert.rejects(sandbox.request("/\\example.com"), /Invalid sandbox request/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(sandbox.request("/api/count", "GET", {}, "", cancelled.signal));
  evidence = { at: new Date().toISOString(), imageId: sandbox.imageId, sourceHashes: sandbox.sourceHashes, probe, apiRoundTrip: true, limitsVerified: true };
} finally { await sandbox.close(); }
await assert.rejects(sandbox.request("/"), /closed/);
await sandbox.close(); // cleanup is idempotent
await assert.rejects(promisify(execFile)("docker", ["inspect", containerId]));
await assert.rejects(promisify(execFile)("docker", ["image", "inspect", sourceImageId]));
const bounded = await BackendSandbox.start(root, "server.mjs", undefined, 1000);
try {
  await new Promise(resolve => setTimeout(resolve, 1500));
  const stopped = await bounded.inspect() as { State: { Running: boolean; ExitCode: number } };
  assert.equal(stopped.State.Running, false);
  assert.equal(stopped.State.ExitCode, 124);
  await assert.rejects(bounded.request("/api/count"));
} finally { await bounded.close(); }
fs.mkdirSync("docs/evidence", { recursive: true });
fs.writeFileSync("docs/evidence/bot-backend-sandbox.json", JSON.stringify({ ...evidence, cleanup: true, lifetimeExpiry: true }, null, 2));
console.log("PASS real container API state, no network/host mounts/socket/secrets, readonly source/root, resource limits and cleanup");
