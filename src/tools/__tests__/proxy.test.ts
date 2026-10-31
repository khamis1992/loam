/**
 * Recording proxy.
 *
 * Every exchange gets a stable id, the recording survives a tool call, a replay
 * cites the original, scope blocks a foreign host, and stop writes the file.
 * The proxy is a real forward proxy: the test sends an absolute-URL request the
 * way `curl -x` does.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { AgentEvent } from "../../agent/events.js";
import type { ToolContext } from "../registry.js";
import { createProxyTools } from "../proxy.js";

const tools = createProxyTools();
const tool = (name: string) => {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
};

let workspace = "";
let upstream: http.Server;
let upstreamPort = 0;
let ctx: ToolContext;
let proxyPort = 0;

function requestThroughProxy(target: string, method = "GET", body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method,
        path: target,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("recording proxy", () => {
  before(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-proxy-"));
    ctx = {
      cfg: {},
      workspace,
      taskId: "task-proxy",
      emit: (_event: AgentEvent) => {},
    } as unknown as ToolContext;
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    assert.ok(address && typeof address === "object");
    upstreamPort = address.port;
  });

  after(async () => {
    await tool("proxy_stop").run({}, ctx);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("starts, records an exchange with an id and replays it", async () => {
    const start = await tool("proxy_start").run({ scope: ["127.0.0.1"] }, ctx);
    assert.equal(start.ok, true, start.content);
    const match = /127\.0\.0\.1:(\d+)/.exec(start.content);
    assert.ok(match, start.content);
    proxyPort = Number(match[1]);

    const target = `http://127.0.0.1:${upstreamPort}/hello`;
    const first = await requestThroughProxy(target, "POST", '{"a":1}');
    assert.equal(first.status, 200);

    const list = await tool("proxy_list_requests").run({ contains: "/hello" }, ctx);
    assert.equal(list.ok, true);
    const id = /px_\d+/.exec(list.content)?.[0];
    assert.ok(id, list.content);

    const view = await tool("proxy_view_request").run({ id }, ctx);
    assert.equal(view.ok, true);
    const parsed = JSON.parse(view.content) as { method: string; requestBody: string; requestHeaders: Record<string, string> };
    assert.equal(parsed.method, "POST");
    assert.equal(parsed.requestBody, '{"a":1}');
    assert.ok(parsed.requestHeaders["content-type"]);

    const replay = await tool("proxy_repeat_request").run({ id, body: '{"a":2}' }, ctx);
    assert.equal(replay.ok, true, replay.content);
    const replayId = /px_\d+/.exec(replay.content)?.[0];
    assert.ok(replayId);
    const replayView = JSON.parse((await tool("proxy_view_request").run({ id: replayId }, ctx)).content) as { parentId: string };
    assert.equal(replayView.parentId, id);
  });

  it("refuses a host outside the scope", async () => {
    const result = await requestThroughProxy("http://127.0.0.2:1/nope");
    assert.equal(result.status, 403);
    const list = await tool("proxy_list_requests").run({ contains: "127.0.0.2" }, ctx);
    assert.match(list.content, /out of scope/);
  });

  it("writes the recording when stopped", async () => {
    const stop = await tool("proxy_stop").run({}, ctx);
    assert.equal(stop.ok, true);
    const file = path.join(workspace, ".loam-proxy", "task-proxy.json");
    assert.equal(fs.existsSync(file), true);
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { exchanges: unknown[] };
    assert.ok(saved.exchanges.length >= 2);
  });
});
