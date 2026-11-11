import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { startProtocolAdapter, type ProtocolAdapter } from "../adapter.js";

test("signed automation triggers proxy without a user session while other APIs stay authenticated", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-automation-proxy-"));
  const previous = { port: process.env.LOAM_PORT, data: process.env.MANUS_LOCAL_DATA_DIR };
  let adapter: ProtocolAdapter | undefined;
  let seenSignature = "";
  const upstream = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/automations/trigger/")) {
      const signature = req.headers["x-loam-signature"];
      seenSignature = typeof signature === "string" ? signature : "";
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ started: true }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as import("node:net").AddressInfo).port;
  process.env.LOAM_PORT = String(upstreamPort);
  process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  try {
    adapter = await startProtocolAdapter({
      cfg: { workspace: tmpDir } as never,
      runTask: (async () => ({ taskId: "task_test", text: "ok" })) as never,
      getTask: () => undefined,
      port: 0,
    });
    const base = `http://127.0.0.1:${adapter.port}`;
    const response = await fetch(`${base}/api/automations/trigger/sched_test`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-loam-signature": "sha256=test" },
      body: JSON.stringify({ orderId: "order-1" }),
    });
    assert.equal(response.status, 202);
    assert.equal(seenSignature, "sha256=test");

    const protectedResponse = await fetch(`${base}/api/schedules`, { method: "POST", body: "{}" });
    assert.equal(protectedResponse.status, 401);
  } finally {
    await adapter?.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (previous.port === undefined) delete process.env.LOAM_PORT;
    else process.env.LOAM_PORT = previous.port;
    if (previous.data === undefined) delete process.env.MANUS_LOCAL_DATA_DIR;
    else process.env.MANUS_LOCAL_DATA_DIR = previous.data;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
