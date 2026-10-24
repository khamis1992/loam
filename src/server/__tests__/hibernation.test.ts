/**
 * J7 daemon hibernation: the local HTTP surface.
 *
 * The route is the only network-shaped surface the feature adds, so these tests
 * pin its boundary (adapted from jcode's hibernation route test, MIT):
 * - the exact paths and methods it serves, and 404/405 for anything else;
 * - `cache-control: no-store` and a JSON content type;
 * - the recorded session counters plus the process-wide counters;
 * - hibernate/wake act on the manager, and wake clears the hibernated flag.
 */
import assert from "node:assert";
import { Readable, Writable } from "node:stream";
import { describe, it, beforeEach } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

import { handleHibernationRoutes, handleHibernationProcessRoutes } from "../routes/hibernation.js";
import { sessionHibernation } from "../../memory/hibernation.js";

class FakeResponse extends Writable {
  statusCode = 0;
  statusMessage = "";
  headers: Record<string, unknown> = {};
  chunks: Buffer[] = [];

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }

  _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body(): Buffer { return Buffer.concat(this.chunks); }
  json(): Record<string, unknown> { return JSON.parse(this.body().toString("utf8")) as Record<string, unknown>; }
}

function fakeRequest(method: string, url: string): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers: { host: "127.0.0.1:4321" } });
  return req;
}

async function call(handler: typeof handleHibernationRoutes, method: string, url: string): Promise<FakeResponse> {
  const res = new FakeResponse() as FakeResponse & ServerResponse;
  await handler(fakeRequest(method, url), res, url);
  return res;
}

const routes = {
  session: handleHibernationRoutes,
  process: handleHibernationProcessRoutes,
};

interface SessionBody {
  record?: { sessionId?: string } | null;
  state?: string;
  msUntilHibernation?: number | null;
  disabled?: boolean;
  releasedEntries?: number;
  releasedBytes?: number;
  error?: string;
}

describe("hibernation routes", () => {
  beforeEach(() => {
    sessionHibernation.reset();
  });

  it("ignores paths outside the feature", async () => {
    const res = await call(routes.session, "GET", "/api/sessions/abc/other");
    assert.equal(res.statusCode, 0);
    assert.equal(res.body().length, 0);
    const proc = await call(routes.process, "GET", "/api/debug/memory");
    assert.equal(proc.statusCode, 0);
    assert.equal(proc.body().length, 0);
  });

  it("reports session state and the configured idle threshold", async () => {
    const res = await call(routes.session, "GET", "/api/sessions/abc/hibernation");
    assert.equal(res.statusCode, 200);
    const body = res.json() as SessionBody;
    // A session that has never been tracked has no record yet, only a state.
    assert.equal(body.record, null);
    assert.equal(body.state, "active");
    assert.equal(body.disabled, false);
    assert.equal(body.msUntilHibernation, null);
  });

  it("is marked no-store and JSON on every response", async () => {
    const res = await call(routes.session, "GET", "/api/sessions/abc/hibernation");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.match(String(res.headers["content-type"]), /^application\/json/);
    assert.equal(Number(res.headers["content-length"]), res.body().length);
  });

  it("reports the ms remaining while a session is idle", async () => {
    sessionHibernation.markIdle("abc");
    const res = await call(routes.session, "GET", "/api/sessions/abc/hibernation");
    const body = res.json() as SessionBody;
    assert.equal(body.state, "idle");
    assert.ok((body.msUntilHibernation ?? 0) <= 30 * 60_000);
    assert.ok((body.msUntilHibernation ?? 0) > 0);
  });

  it("hibernate releases derived caches and records the counters", async () => {
    sessionHibernation.setOwners("abc", [
      { name: "projection", size: () => 2, bytes: () => 32, clear: () => undefined },
      { name: "frames", size: () => 1, bytes: () => 8, clear: () => undefined },
    ]);
    sessionHibernation.markIdle("abc");
    const res = await call(routes.session, "POST", "/api/sessions/abc/hibernate");
    assert.equal(res.statusCode, 200);
    const body = res.json() as SessionBody;
    assert.equal(body.state, "hibernated");
    assert.equal(body.releasedEntries, 3);
    assert.equal(body.releasedBytes, 40);
    assert.equal(sessionHibernation.getState("abc"), "hibernated");
    assert.equal(sessionHibernation.stats().entriesReleased, 3);
    assert.equal(sessionHibernation.stats().bytesReleased, 40);
    assert.equal(sessionHibernation.stats().hibernations, 1);
  });

  it("wake clears the hibernated flag", async () => {
    sessionHibernation.setOwners("abc", [{ name: "projection", size: () => 1, clear: () => undefined }]);
    sessionHibernation.markIdle("abc");
    sessionHibernation.hibernateSession("abc", { immediate: true });
    assert.equal(sessionHibernation.getState("abc"), "hibernated");
    const res = await call(routes.session, "POST", "/api/sessions/abc/wake");
    assert.equal(res.statusCode, 200);
    const body = res.json() as SessionBody;
    assert.equal(body.state, "active");
    assert.equal(sessionHibernation.getState("abc"), "active");
  });

  it("rejects a hibernation path without a session id", async () => {
    // An empty id segment never matches the route, so the handler declines.
    const res = await call(routes.session, "GET", "/api/sessions//hibernation");
    assert.equal(res.statusCode, 0);
    assert.equal(res.body().length, 0);
  });

  it("rejects every unsupported method", async () => {
    for (const method of ["PUT", "DELETE", "PATCH", "HEAD"]) {
      const res = await call(routes.session, method, "/api/sessions/abc/hibernation");
      assert.equal(res.statusCode, 405, `${method} must be rejected`);
      assert.equal((res.json() as SessionBody).error, "method not allowed");
    }
  });

  it("reports the process-wide counters and config", async () => {
    const res = await call(routes.process, "GET", "/api/hibernation");
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown> & { sessions?: unknown[] };
    assert.equal(body.idleMinutes, 30);
    assert.equal(body.disabled, false);
    assert.ok(Array.isArray(body.sessions), "the process route lists per-session records");
    assert.equal(typeof body.hibernations, "number");
    assert.equal(typeof body.entriesReleased, "number");
    assert.equal(typeof body.bytesReleased, "number");
  });

  it("rejects every method other than GET on the process route", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
      const res = await call(routes.process, method, "/api/hibernation");
      assert.equal(res.statusCode, 405, `${method} must be rejected`);
      assert.equal((res.json() as SessionBody).error, "Method not allowed");
    }
  });
});
