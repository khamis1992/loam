import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { createAuthorizationRecord } from "../../red/gate.js";
import { inspectSpaJavaScript, reviewWebSocketHandshake, testGraphQLAuthorization } from "../protocols.js";
import { runRaceScenario } from "../business.js";

const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

describe("modern web protocols", () => {
  it("detects GraphQL field authorization with a positive control", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        const owner = req.headers.authorization === "owner";
        if (req.url === "/vulnerable") return res.end(JSON.stringify({ data: { user: { identity: owner ? "owner" : "other", secret: "private-marker" } } }));
        if (owner) return res.end(JSON.stringify({ data: { user: { identity: "owner", secret: "private-marker" } } }));
        res.statusCode = 403;
        res.end(JSON.stringify({ errors: [{ message: "denied" }] }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const port = (server.address() as import("node:net").AddressInfo).port;
    const authz = createAuthorizationRecord({ statement: "GraphQL lab", expiresInSeconds: 300, scope: { allowHosts: ["127.0.0.1"], allowPorts: [port], allowUrlPrefixes: [], denyAlways: [] } });
    const owner = { id: "owner", headers: { authorization: "owner" } };
    const other = { id: "other", headers: { authorization: "other" } };
    const query = "query { user { identity secret } }";
    assert.equal((await testGraphQLAuthorization(authz, { url: `http://127.0.0.1:${port}/vulnerable`, query, privateMarker: "private-marker", ownerIdentity: "owner" }, owner, other)).status, "finding");
    assert.equal((await testGraphQLAuthorization(authz, { url: `http://127.0.0.1:${port}/safe`, query, privateMarker: "private-marker", ownerIdentity: "owner" }, owner, other)).status, "pass");
  });

  it("reviews WebSocket security and SPA indicators without false confirmation", () => {
    assert.equal(reviewWebSocketHandshake({ url: "ws://socket.test", status: 101, authenticated: false, requiresAuthentication: true }).status, "finding");
    assert.equal(reviewWebSocketHandshake({ url: "wss://socket.test", status: 101, authenticated: false, requiresAuthentication: true }).status, "finding");
    assert.equal(reviewWebSocketHandshake({ url: "wss://socket.test", status: 403, authenticated: false, requiresAuthentication: true }).status, "pass");
    const review = inspectSpaJavaScript("fetch('/api/users'); postMessage(data, '*'); element.innerHTML=input;//# sourceMappingURL=app.js.map");
    assert.deepEqual(review.endpoints, ["/api/users"]);
    assert.ok(review.indicators.every((indicator) => indicator.status === "review"));
    assert.equal(review.sourceMaps[0], "app.js.map");
  });

  it("proves concurrent limit bypass with bounded attempts", async () => {
    const result = await runRaceScenario("race", async () => ({ accepted: true, state: "charged", evidenceId: crypto.randomUUID() }), { attempts: 4, allowedSuccesses: 1 });
    assert.equal(result.status, "finding");
  });
});
