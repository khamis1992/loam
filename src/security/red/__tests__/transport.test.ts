/**
 * Red transport tests (RED_TEAM_BUILD_SPEC §4.2, §5.4).
 *
 * The red transport is the only in-process HTTP surface of the red build: every
 * request passes the §0.4 gate first, is rate-limited, budgeted, aborted by
 * the kill-switch, and records evidence. Unlike the blue scopedTransport it may
 * carry POST bodies (payload delivery) without weakening the blue path.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";

import { createAuthorizationRecord, engageKillSwitch, resetKillSwitch, type AuthorizationRecord } from "../gate.js";
import { RedBudgetError, RedGateError, redTransport, type RedTransport } from "../transport.js";

const startServer = async (handler: http.RequestListener): Promise<{ server: http.Server; url: string }> => {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}` };
};

const authzFor = (port: number): AuthorizationRecord =>
  createAuthorizationRecord({
    statement: "lab",
    expiresInSeconds: 3600,
    scope: { allowHosts: ["127.0.0.1"], allowPorts: [port], allowUrlPrefixes: [], denyAlways: [] },
  });

describe("red transport", () => {
  it("GET an in-scope target: allowed, evidenced, headers parsed", async () => {
    const { server, url } = await startServer((req, res) => {
      res.setHeader("X-Powered-By", "express");
      res.end("hello");
    });
    try {
      const t: RedTransport = redTransport(authzFor((server.address() as import("node:net").AddressInfo).port));
      const r = await t.request(url);
      assert.equal(r.status, 200);
      assert.equal(r.headers["x-powered-by"], "express");
      assert.equal(t.evidence.length, 1);
      assert.equal(t.evidence[0]!.method, "GET");
      assert.equal(t.evidence[0]!.url, url);
    } finally {
      server.close();
    }
  });

  it("POST with a body is allowed and recorded (payload delivery)", async () => {
    let seen = "";
    const { server, url } = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen = body;
        res.end("ok");
      });
    });
    try {
      const t = redTransport(authzFor((server.address() as import("node:net").AddressInfo).port));
      const r = await t.request(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "x=1" });
      assert.equal(r.status, 200);
      assert.equal(seen, "x=1");
      assert.equal(t.evidence[0]!.requestBody, "x=1");
    } finally {
      server.close();
    }
  });

  it("an out-of-scope URL throws RedGateError before any packet leaves", async () => {
    const t = redTransport(authzFor(1)); // port 1 not the server's
    await assert.rejects(() => t.request("http://127.0.0.1:2/x", {}), RedGateError);
    assert.equal(t.count, 0);
  });

  it("kill-switch denies new requests mid-flight", async () => {
    const { server, url } = await startServer((_req, res) => res.end("ok"));
    try {
      const t = redTransport(authzFor((server.address() as import("node:net").AddressInfo).port));
      engageKillSwitch();
      try {
        await assert.rejects(() => t.request(url), (err: unknown) => err instanceof RedGateError && /kill-switch/.test(err.message));
      } finally {
        resetKillSwitch();
      }
    } finally {
      server.close();
    }
  });

  it("§5.5a: engaging the kill-switch aborts an in-flight request (slow lab)", async () => {
    let released: (() => void) | undefined;
    const { server, url } = await startServer((_req, res) => {
      released = () => res.end("late");
    });
    try {
      const port = (server.address() as import("node:net").AddressInfo).port;
      const t = redTransport(authzFor(port), { timeoutMs: 5000 });
      const pending = t.request(url);
      await new Promise((resolve) => setTimeout(resolve, 50)); // request is now in-flight
      engageKillSwitch();
      await assert.rejects(() => pending, /This operation was aborted|abort/i);
      released?.();
      resetKillSwitch();
    } finally {
      server.close();
      resetKillSwitch();
    }
  });

  it("the campaign request budget is enforced (BudgetError semantics)", async () => {
    const { server, url } = await startServer((_req, res) => res.end("ok"));
    try {
      const a = authzFor((server.address() as import("node:net").AddressInfo).port);
      const budgetted = createAuthorizationRecord({
        statement: "lab",
        expiresInSeconds: 3600,
        limits: { maxTotalRequests: 2 },
        scope: a.scope,
      });
      const t = redTransport(budgetted);
      assert.equal((await t.request(url)).status, 200);
      assert.equal((await t.request(url)).status, 200);
      await assert.rejects(() => t.request(url), RedBudgetError);
    } finally {
      server.close();
    }
  });

  it("response bodies are capped at maxBodyBytes and marked truncated", async () => {
    const { server, url } = await startServer((_req, res) => res.end("a".repeat(100)));
    try {
      const t = redTransport(authzFor((server.address() as import("node:net").AddressInfo).port), { maxBodyBytes: 10 });
      const r = await t.request(url);
      assert.equal(r.body.length, 10);
      assert.equal(r.bodyTruncated, true);
    } finally {
      server.close();
    }
  });

  it("destructive DELETE requires the approval callback", async () => {
    let hits = 0;
    const { server, url } = await startServer((req, res) => {
      hits++;
      res.end("gone");
    });
    try {
      const port = (server.address() as import("node:net").AddressInfo).port;
      const a = authzFor(port);
      const strict = redTransport(a, { approval: () => false });
      await assert.rejects(() => strict.request(url, { method: "DELETE" }), RedGateError);
      assert.equal(hits, 0, "no packet may leave without approval");
      const lax = redTransport(a, { approval: () => true });
      assert.equal((await lax.request(url, { method: "DELETE" })).status, 200);
      assert.equal(hits, 1);
    } finally {
      server.close();
    }
  });
});
