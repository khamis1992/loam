/**
 * Hardening regressions for the evidence-gated pentest orchestrator.
 *
 * These cover the review fixes: probe-failure false positives, cookie/header
 * redaction before evidence is persisted, credential-bearing targets, evidence
 * retention when a check throws, and a faulty PoC assertion that must not abort
 * the validate phase.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";

import {
  assertLocalhost,
  isLocalhostTarget,
  reconAgent,
  validateAgent,
  orchestrate,
  redactEvidenceHeaders,
  RecordingRunner,
  type Evidence,
  type Hypothesis,
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

function httpResult(over: Partial<HttpResult> = {}): HttpResult {
  return { ok: true, status: 200, headers: {}, setCookie: [], body: "<html></html>", ...over };
}

/** Runner with a fixed recon finding and a fixed (possibly failed) probe result. */
class FixedRunner implements PentestRunner {
  readonly evidence: Evidence[] = [];
  constructor(private readonly findings: PentestFinding[], private readonly probeResult: HttpResult) {}
  async check(): Promise<PentestFinding[]> {
    return this.findings;
  }
  async probe(): Promise<HttpResult> {
    return this.probeResult;
  }
}

describe("orchestrator hardening: scope", () => {
  it("refuses targets carrying embedded credentials", () => {
    assert.throws(() => assertLocalhost("http://user:pw@localhost:3000/"), /non-localhost/);
    assert.equal(isLocalhostTarget("http://user:pw@localhost:3000/"), false);
  });

  it("normalizes a trailing-dot loopback host instead of rejecting it", () => {
    assert.equal(isLocalhostTarget("http://localhost.:3000/"), true);
    assert.equal(assertLocalhost("http://localhost.:3000/"), "http://localhost.:3000/");
  });
});

describe("orchestrator hardening: evidence redaction", () => {
  it("drops cookie and authorization headers while keeping the rest", () => {
    const redacted = redactEvidenceHeaders({
      "content-type": "text/html",
      "set-cookie": "sid=supersecret; Path=/",
      Cookie: "session=abc",
      Authorization: "Bearer tok",
      "x-frame-options": "DENY",
    });
    assert.deepEqual(Object.keys(redacted).sort(), ["content-type", "x-frame-options"]);
    assert.equal(redacted["set-cookie"], undefined);
  });

  it("never persists raw cookie values through the recording runner", async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-security-policy", "default-src 'self'");
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("set-cookie", "sid=topsecretvalue; Path=/; HttpOnly");
      res.end("ok");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      const runner = new RecordingRunner();
      const result = await runner.probe({ url: `http://127.0.0.1:${port}/` });
      assert.equal(result.status, 200);
      const ev = runner.evidence[0]!;
      assert.equal(ev.headers?.["set-cookie"], undefined, "raw set-cookie must not be persisted");
      assert.ok(ev.headers?.["content-security-policy"], "non-sensitive headers are still captured");
      assert.ok(ev.cookieFlags?.[0]?.includes("<redacted>"), "cookie flags are summarized, not raw");
      assert.ok(!JSON.stringify(ev).includes("topsecretvalue"), "no cookie value leaks anywhere in the evidence");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("orchestrator hardening: gate and phases", () => {
  it("does not confirm missing headers on a failed probe", async () => {
    const runner = new FixedRunner([headerFinding], httpResult({ ok: false, status: 0, headers: {}, body: "" }));
    const result = await orchestrate({ target: LOCAL_TARGET, checks: ["security_headers"], runner });
    assert.equal(result.findings.length, 0, "a failed request is not evidence of a missing header");
    assert.equal(result.unverified.length, 1);
    assert.match(result.unverified[0]!.reason, /not "confirmed"/);
  });

  it("does not confirm missing headers on a non-2xx response", async () => {
    const runner = new FixedRunner([headerFinding], httpResult({ ok: false, status: 404, headers: {}, body: "not found" }));
    const result = await orchestrate({ target: LOCAL_TARGET, checks: ["security_headers"], runner });
    assert.equal(result.findings.length, 0);
    assert.equal(result.unverified.length, 1);
  });

  it("keeps evidence recorded before a recon check throws", async () => {
    const runner: PentestRunner = {
      evidence: [],
      async check() {
        (this.evidence as Evidence[]).push({
          id: "EV-PRE",
          kind: "request_response",
          at: new Date().toISOString(),
          url: LOCAL_TARGET,
          method: "GET",
          status: 200,
          response: "partial",
        });
        throw new Error("socket exploded");
      },
      async probe() {
        return httpResult();
      },
    };
    const { observations } = await reconAgent({ target: LOCAL_TARGET, checks: ["security_headers"], runner });
    assert.equal(observations.length, 1);
    assert.equal(observations[0]!.verdict, "error");
    assert.equal(observations[0]!.evidence.length, 1, "pre-failure evidence stays auditable");
  });

  it("treats a throwing PoC assertion as inconclusive rather than aborting", async () => {
    const hypothesis: Hypothesis = {
      id: "HYP-THROW",
      source: "OBS1",
      check: "security_headers",
      target: LOCAL_TARGET,
      title: "throwing assertion",
      rationale: "test",
      probe: { url: LOCAL_TARGET, method: "GET" } as ProbeRequest,
      confirm: () => {
        throw new Error("boom");
      },
    };
    const runner = new FixedRunner([], httpResult());
    const outcomes = await validateAgent({ hypotheses: [hypothesis], runner });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.status, "inconclusive");
    assert.match(outcomes[0]!.detail, /assertion failed/);
  });

  it("honors a pre-aborted signal before any check runs", async () => {
    const runner = new FixedRunner([headerFinding], httpResult());
    await assert.rejects(
      () => orchestrate({ target: LOCAL_TARGET, checks: ["security_headers"], runner, signal: AbortSignal.abort() }),
    );
  });
});
