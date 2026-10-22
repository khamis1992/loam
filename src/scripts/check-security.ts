import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { runPentestCheck, scanWorkspaceRoutesAndRisks } from "../tools/pentest.js";
import { startAssessment, readAssessment, cancelAssessment, listAssessments, assessmentReport } from "../security/assessments.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-security-"));
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  if (req.url === "/error") { res.writeHead(503).end("Unavailable"); return; }
  if (req.url === "/redirect") { res.writeHead(302, { location: "/" }).end(); return; }
  if (req.url === "/slow") return;
  if (req.url === "/.env") { res.end("DATABASE_PASSWORD=do-not-copy-this-secret"); return; }
  if (req.url !== "/") { res.writeHead(404).end(); return; }
  res.setHeader("set-cookie", "id=secure-httponly-samesite");
  res.setHeader("access-control-allow-origin", req.headers.origin || "*");
  res.setHeader("access-control-allow-credentials", "true");
  res.end("<h1>Fixture</h1>");
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const target = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
async function finished(id: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const run = readAssessment(root, id); if (run.status !== "running") return run;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error("Assessment timed out");
}
try {
  await assert.rejects(runPentestCheck("file:///etc/passwd"));
  await assert.rejects(runPentestCheck(target, "unknown"));
  const cookies = await runPentestCheck(target, "cookie_flags"); assert.equal(cookies[0]?.verdict, "finding");
  const unavailable = await runPentestCheck(target + "/error", "directory_listing"); assert.equal(unavailable[0]?.verdict, "error");
  const before = hits; const redirects = await runPentestCheck(target + "/redirect", "security_headers");
  assert.equal(hits, before + 1); assert.equal(redirects[0]?.verdict, "error");
  const files = await runPentestCheck(target, "exposed_files"); assert.equal(files[0]?.severity, "high");
  assert.ok(!JSON.stringify(files).includes("do-not-copy-this-secret"));
  fs.writeFileSync(path.join(root, "app.js"), 'const password = "abcdefghijklmnopqrst";\napp.get("/api/test", handler);');
  const scan = scanWorkspaceRoutesAndRisks(root); assert.equal(scan.filesScanned, 1); assert.equal(scan.routes.length, 1);
  assert.ok(!JSON.stringify(scan).includes("abcdefghijklmnopqrst"));
  assert.throws(() => startAssessment(root, { target }));
  assert.throws(() => startAssessment(root, { target, authorized: true, checks: ["invalid"] }));
  const started = startAssessment(root, { target, authorized: true, includeSource: true });
  assert.throws(() => startAssessment(root, { target, authorized: true }), /already running/);
  const run = await finished(started.id); assert.equal(run.status, "completed"); assert.equal(run.completed, 9);
  assert.ok(run.findings.some(f => f.check === "cors_policy" && f.severity === "high"));
  assert.equal(listAssessments(root).length, 1); assert.match(assessmentReport(root, run.id), /Status: completed/);
  assert.throws(() => readAssessment(root, "../escape"));
  const other = fs.mkdtempSync(path.join(root, "other-")); assert.throws(() => readAssessment(other, run.id), /not found/);
  const slow = startAssessment(root, { target: target + "/slow", authorized: true, checks: ["security_headers"] });
  cancelAssessment(root, slow.id); assert.equal((await finished(slow.id)).status, "cancelled");
  const interrupted = { ...run, status: "running" }; fs.writeFileSync(path.join(root, ".loam/security", run.id + ".json"), JSON.stringify(interrupted));
  assert.equal(readAssessment(root, run.id).status, "interrupted");
  const empty=fs.mkdtempSync(path.join(root,'empty-'));
  const emptyStart=startAssessment(empty,{includeSource:true,includeDependencies:true});
  let emptyRun=readAssessment(empty,emptyStart.id);
  while(emptyRun.status==='running'){await new Promise(r=>setTimeout(r,20));emptyRun=readAssessment(empty,emptyStart.id);}
  assert.equal(emptyRun.status,'partial');
  assert.equal(emptyRun.diagnostics?.modules.find(m=>m.id==='source')?.state,'no_execution');
  assert.equal(emptyRun.diagnostics?.modules.find(m=>m.id==='browser')?.state,'disabled');
  assert.ok(emptyRun.diagnostics?.reasons.length);
  console.log("PASS: real HTTP checks, failures, redirects, redaction, scope isolation, persistence, cancellation and restart recovery");
} finally { server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); }
