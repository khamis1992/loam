/**
 * Unit tests for the evidence-gated pentest orchestrator.
 *
 * The mock runner is the only side-effecting surface: it returns canned recon
 * findings and canned probe responses, so the tests exercise the gate and the
 * phase composition without touching the network.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import {
  assertLocalhost,
  isLocalhostTarget,
  evaluateEvidenceGate,
  isValidEvidence,
  demonstratesClaim,
  orchestrate,
  type Evidence,
  type PentestRunner,
  type ProbeRequest,
} from "../orchestrator.js";
import type { HttpResult } from "../scope.js";
import type { PentestFinding } from "../../tools/pentest.js";

const LOCAL_TARGET = "http://127.0.0.1:3000";

const headerFinding: PentestFinding = {
  id: "F1",
  check: "security_headers",
  verdict: "finding",
  severity: "medium",
  title: "Missing HTTP security headers",
  target: LOCAL_TARGET,
  detail: "Missing: Content-Security-Policy, X-Frame-Options",
};

function httpResult(headers: Record<string, string>, body = "<html></html>"): HttpResult {
  return { ok: true, status: 200, headers, setCookie: [], body };
}

const vulnerable = httpResult({ "content-type": "text/html" });
const hardened = httpResult({
  "content-type": "text/html",
  "content-security-policy": "default-src 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=()",
});

/** Mock runner: returns fixed recon findings and a fixed probe response. */
class MockRunner implements PentestRunner {
  readonly evidence: Evidence[] = [];
  constructor(
    private readonly findings: PentestFinding[],
    private readonly probeResult: HttpResult,
    private readonly recordEvidence = true,
  ) {}
  async check(): Promise<PentestFinding[]> {
    return this.findings;
  }
  async probe(request: ProbeRequest): Promise<HttpResult> {
    if (this.recordEvidence) {
      this.evidence.push({
        id: `MOCK${this.evidence.length + 1}`,
        kind: "request_response",
        at: new Date().toISOString(),
        url: request.url,
        method: request.method ?? "GET",
        status: this.probeResult.status,
        response: this.probeResult.body,
      });
    }
    return this.probeResult;
  }
}

const validResponseEvidence = (): Evidence => ({
  id: "EV-RESP",
  kind: "request_response",
  at: new Date().toISOString(),
  url: LOCAL_TARGET,
  method: "GET",
  status: 200,
  response: "<html>vulnerable</html>",
});

const validPocEvidence = (): Evidence => ({
  id: "EV-POC",
  kind: "poc",
  at: new Date().toISOString(),
  poc: `GET ${LOCAL_TARGET}`,
  observed: "Missing Content-Security-Policy on HTTP 200",
});

describe("localhost scope", () => {
  it("accepts loopback HTTP(S) targets", () => {
    for (const target of ["http://127.0.0.1:3000", "http://localhost:8080", "https://[::1]:443", "http://0.0.0.0:9"]) {
      assert.equal(isLocalhostTarget(target), true, target);
    }
  });

  it("rejects non-loopback and non-HTTP targets", () => {
    for (const target of ["http://example.com", "https://10.0.0.5", "file:///etc/passwd", "not a url"]) {
      assert.equal(isLocalhostTarget(target), false, target);
    }
    assert.throws(() => assertLocalhost("http://example.com"), /non-localhost/);
  });
});

describe("evidence gate", () => {
  it("blocks a confirmed claim with no evidence", () => {
    const gate = evaluateEvidenceGate({ id: "H1", claim: "XSS", status: "confirmed", evidence: [] });
    assert.equal(gate.gated, false);
    assert.equal(gate.reported, false);
    assert.match(gate.reason, /no valid evidence/);
  });

  it("blocks a confirmed claim whose evidence is malformed", () => {
    const malformed: Evidence = { id: "EV-BAD", kind: "request_response", at: new Date().toISOString(), url: LOCAL_TARGET, method: "GET", status: 200 };
    const gate = evaluateEvidenceGate({ id: "H1", claim: "XSS", status: "confirmed", evidence: [malformed] });
    assert.equal(gate.gated, false);
    assert.match(gate.reason, /no valid evidence/);
  });

  it("blocks an omitted response body (bodyOmitted) even with a status", () => {
    const omitted: Evidence = { id: "EV-OMIT", kind: "request_response", at: new Date().toISOString(), url: LOCAL_TARGET, method: "GET", status: 200, bodyOmitted: true };
    const gate = evaluateEvidenceGate({ id: "H1", claim: "XSS", status: "confirmed", evidence: [omitted] });
    assert.equal(gate.gated, false);
    assert.match(gate.reason, /does not demonstrate/);
  });

  it("allows a confirmed claim backed by a captured response", () => {
    const gate = evaluateEvidenceGate({ id: "H1", claim: "Missing CSP", status: "confirmed", evidence: [validResponseEvidence()] });
    assert.equal(gate.gated, true);
    assert.equal(gate.reported, true);
    assert.equal(gate.reason, "");
  });

  it("allows a confirmed claim backed by a PoC observation", () => {
    const gate = evaluateEvidenceGate({ id: "H1", claim: "Missing CSP", status: "confirmed", evidence: [validPocEvidence()] });
    assert.equal(gate.gated, true);
    assert.equal(gate.reported, true);
  });

  it("never reports a non-confirmed status, even with evidence", () => {
    for (const status of ["refuted", "inconclusive"] as const) {
      const gate = evaluateEvidenceGate({ id: "H1", claim: "Missing CSP", status, evidence: [validResponseEvidence()] });
      assert.equal(gate.gated, false, status);
      assert.equal(gate.reported, false, status);
      assert.match(gate.reason, /not "confirmed"/);
    }
  });

  it("classifies evidence validity and demonstration", () => {
    assert.equal(isValidEvidence(validResponseEvidence()), true);
    assert.equal(isValidEvidence(validPocEvidence()), true);
    assert.equal(isValidEvidence(undefined), false);
    assert.equal(demonstratesClaim(validResponseEvidence()), true);
    assert.equal(demonstratesClaim(validPocEvidence()), true);
  });
});

describe("orchestrate (mock runner)", () => {
  it("reports exactly one gated finding when the PoC reproduces the recon signal", async () => {
    const runner = new MockRunner([headerFinding], vulnerable);
    const result = await orchestrate({ target: LOCAL_TARGET, checks: ["security_headers"], runner });

    assert.equal(result.phases.recon, 1);
    assert.equal(result.phases.hypothesis, 1);
    assert.equal(result.phases.validate, 1);
    assert.equal(result.findings.length, 1);
    assert.equal(result.unverified.length, 0);
    assert.equal(result.findings[0]!.check, "security_headers");
    assert.ok(result.findings[0]!.evidence.length >= 1, "finding must carry evidence");
    assert.ok(result.findings[0]!.evidence.some((e) => e.kind === "poc"), "finding must carry a PoC observation");
  });

  it("withholds the claim when the PoC does not reproduce it", async () => {
    const runner = new MockRunner([headerFinding], hardened);
    const result = await orchestrate({ target: LOCAL_TARGET, checks: ["security_headers"], runner });

    assert.equal(result.findings.length, 0, "no exploit may be reported without a reproducing PoC");
    assert.equal(result.unverified.length, 1);
    assert.match(result.unverified[0]!.reason, /not "confirmed"/);
  });

  it("withholds the claim when the probe fails outright", async () => {
    const failing: PentestRunner = {
      evidence: [],
      async check() {
        return [headerFinding];
      },
      async probe() {
        throw new Error("connection refused");
      },
    };
    const result = await orchestrate({ target: LOCAL_TARGET, checks: ["security_headers"], runner: failing });
    assert.equal(result.findings.length, 0);
    assert.equal(result.unverified.length, 1);
    assert.match(result.unverified[0]!.detail, /connection refused/);
  });

  it("refuses a non-localhost target before any phase runs", async () => {
    await assert.rejects(
      () => orchestrate({ target: "http://example.com", checks: ["security_headers"], runner: new MockRunner([], vulnerable) }),
      /non-localhost/,
    );
  });
});
