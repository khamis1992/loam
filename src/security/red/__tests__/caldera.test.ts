/**
 * Caldera adversary-simulation client tests (RED_TEAM_BUILD_SPEC §6.9).
 * A local mock caldera stands in for the real lab service.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, it } from "node:test";

import { RedAuditLog } from "../audit.js";
import { createAuthorizationRecord } from "../gate.js";
import { redTransport } from "../transport.js";
import type { RedCapabilityContext } from "../orchestrator/redOrchestrator.js";
import { listAdversaries, runOperation } from "../advsim/caldera.js";

const ctxFor = (port: number): RedCapabilityContext => {
  const authz = createAuthorizationRecord({
    statement: "lab",
    expiresInSeconds: 3600,
    scope: { allowHosts: ["127.0.0.1"], allowPorts: [port], allowUrlPrefixes: [], denyAlways: [] },
  });
  return { authz, transport: redTransport(authz), bridge: async () => ({ ok: false, exitCode: null, timedOut: false }), audit: new RedAuditLog(fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-caldera-"))) };
};

describe("caldera client", () => {
  it("lists adversary profiles from /api/adversaries", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/api/adversaries") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([{ adversary_id: "a1", name: "Scout" }, { adversary_id: "a2", name: "Hunter" }, { broken: true }]));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      const profiles = await listAdversaries(`http://127.0.0.1:${port}`, ctxFor(port));
      assert.equal(profiles.length, 2);
      assert.deepEqual(profiles.map((p) => p.name), ["Scout", "Hunter"]);
    } finally {
      server.close();
    }
  });

  it("runs an operation and maps executed abilities to ATT&CK coverage", async () => {
    let operationId = "";
    let polls = 0;
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/api/operations") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body) as { adversary: { adversary_id: string } };
          assert.equal(parsed.adversary.adversary_id, "a1");
          operationId = "op-42";
          res.statusCode = 201;
          res.end(JSON.stringify({ id: operationId }));
        });
        return;
      }
      if (req.method === "GET" && req.url === `/api/operations/${operationId}`) {
        polls++;
        res.end(JSON.stringify(polls < 2 ? { id: operationId, state: "running", chain: [] } : {
          id: operationId,
          state: "finished",
          chain: [
            { ability: { technique_id: "T1082", name: "System Information Discovery" }, status: "0" },
            { ability: { technique_id: "T1059", name: "Command and Scripting Interpreter" }, status: "1" },
          ],
        }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      const ctx = ctxFor(port);
      const coverage = await runOperation(`http://127.0.0.1:${port}`, { id: "a1", name: "Hunter", abilities: [] }, ["127.0.0.1"], ctx, { pollDelayMs: 10 });
      assert.equal(coverage.operationId, "op-42");
      assert.equal(coverage.executed.length, 2);
      assert.equal(coverage.executed[0]!.attackId, "T1082");
      assert.equal(coverage.executed[1]!.result, "1");
    } finally {
      server.close();
    }
  });

  it("an unfinished operation times out with a clear error", async () => {
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/operations") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.statusCode = 201;
          res.end(JSON.stringify({ id: "op-9" }));
        });
        return;
      }
      res.end(JSON.stringify({ state: "running", chain: [] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      const ctx = ctxFor(port);
      await assert.rejects(
        () => runOperation(`http://127.0.0.1:${port}`, { id: "a1", name: "H", abilities: [] }, [], ctx, { maxPolls: 2, pollDelayMs: 5 }),
        /did not finish/,
      );
    } finally {
      server.close();
    }
  });
});
