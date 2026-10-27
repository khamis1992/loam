import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import { MOBILE_SCALE_CORPUS, runMobileScaleCorpus, type MobileBenchCase } from "../security/bench/mobileCorpus.js";
import { testMobileAuthorization } from "../security/mobile/apiAuthorization.js";
import { runBusinessScenario, type BusinessObservation } from "../security/mobile/businessLogic.js";
import { createAuthorizationRecord } from "../security/red/gate.js";

const lab = http.createServer((req, res) => {
  const auth = req.headers.authorization;
  const parts = (req.url ?? "").split("/");
  const expected = parts[1];
  const owner = auth === "owner";
  if (expected === "ambiguous") {
    if (owner) return res.end(JSON.stringify({ identity: "owner", marker: "private-record" }));
    return res.end(JSON.stringify({ identity: "public" }));
  }
  if (expected === "control") {
    res.statusCode = 403;
    return res.end("control unavailable");
  }
  const vulnerable = expected === "vulnerable";
  if (owner || vulnerable) return res.end(JSON.stringify({ identity: owner ? "owner" : "other", marker: "private-record" }));
  res.statusCode = 403;
  res.end("denied");
});
lab.listen(0, "127.0.0.1");
await once(lab, "listening");
const port = (lab.address() as import("node:net").AddressInfo).port;
const authz = createAuthorizationRecord({ statement: "mobile scale corpus localhost lab", expiresInSeconds: 300, scope: { allowHosts: ["127.0.0.1"], allowPorts: [port], allowUrlPrefixes: [], denyAlways: [] } });
const owner = { id: "owner", headers: { authorization: "owner" } };
const other = { id: "other", headers: { authorization: "other" } };

async function runCase(testCase: MobileBenchCase) {
  const started = Date.now();
  if (testCase.family === "authorization") {
    const result = await testMobileAuthorization(authz, { id: testCase.id, url: `http://127.0.0.1:${port}/${testCase.expected === "vulnerable" ? "vulnerable" : testCase.variant === "ambiguous" ? "ambiguous" : testCase.variant === "control" ? "control" : "safe"}`, privateMarker: "private-record", ownerIdentity: "owner" }, owner, other);
    return { actual: result.status === "finding" ? "finding" as const : result.status === "pass" ? "clean" as const : "inconclusive" as const, durationMs: Date.now() - started };
  }
  const vulnerable = testCase.expected === "vulnerable";
  let replayCount = 0;
  const execute = async (step: string): Promise<BusinessObservation> => {
    if (testCase.variant === "quota") return { accepted: vulnerable || step !== "c", state: step, evidenceId: `EV-${testCase.id}-${step}` };
    if (testCase.variant === "replay") return { accepted: true, state: vulnerable ? `charge-${++replayCount}` : "charge-1", evidenceId: `EV-${testCase.id}-${step}` };
    if (testCase.variant === "offline") return { accepted: true, state: vulnerable ? "local-only" : "server-confirmed", evidenceId: `EV-${testCase.id}-${step}` };
    if (testCase.variant === "recovery") return { accepted: true, state: vulnerable ? "recovered-without-identity" : "identity-verified", evidenceId: `EV-${testCase.id}-${step}` };
    if (testCase.variant === "refund") return { accepted: true, state: vulnerable ? "refunded-unauthorized" : "server-approved", evidenceId: `EV-${testCase.id}-${step}` };
    return { accepted: true, state: step, evidenceId: `EV-${testCase.id}-${step}` };
  };
  let result;
  if (testCase.variant === "order") result = await runBusinessScenario({ id: testCase.id, kind: "step-order", steps: vulnerable ? ["pay", "login"] : ["login", "pay"], expectedOrder: ["login", "pay"] }, execute);
  else if (testCase.variant === "quota") result = await runBusinessScenario({ id: testCase.id, kind: "quota", steps: ["a", "b", "c"], quota: 2 }, execute);
  else if (testCase.variant === "replay") result = await runBusinessScenario({ id: testCase.id, kind: "replay", steps: ["charge", "charge"] }, execute);
  else result = await runBusinessScenario({ id: testCase.id, kind: "offline", steps: ["sync"], expectedFinalState: testCase.variant === "offline" ? "server-confirmed" : testCase.variant === "recovery" ? "identity-verified" : "server-approved" }, execute);
  return { actual: result.status === "finding" ? "finding" as const : result.status === "pass" ? "clean" as const : "inconclusive" as const, durationMs: Date.now() - started };
}

try {
  const result = await runMobileScaleCorpus(runCase);
  assert.equal(MOBILE_SCALE_CORPUS.length, 20);
  assert.equal(result.total, 20);
  assert.equal(result.unavailable, 0);
  assert.ok(result.inconclusive <= 2, "only the two declared negative controls may be inconclusive");
  assert.equal(result.score.tp, 9);
  assert.equal(result.score.tn, 9);
  assert.equal(result.score.fp, 0);
  assert.equal(result.score.fn, 0);
  assert.equal(result.score.precision, 1);
  assert.equal(result.score.recall, 1);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "loam-mobile-scale-bench-")), "result.json");
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`check:mobile:scale PASS — ${result.total} cases, ${result.score.tp} TP/${result.score.tn} TN, ${result.inconclusive} declared inconclusive, precision=${result.score.precision}, recall=${result.score.recall}, report=${out}`);
} finally {
  lab.close();
}
