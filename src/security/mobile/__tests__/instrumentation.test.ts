import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { EvidenceTimeline } from "../evidenceTimeline.js";
import { MobileInstrumentationProvider } from "../instrumentation.js";
import { AndroidDeviceWorker } from "../worker.js";

const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

describe("mobile instrumentation", () => {
  it("captures allowlisted evidence and redacts it into the timeline", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const input = JSON.parse(body) as { action: string; packageName: string };
        assert.equal(input.action, "appium.capture-network");
        assert.equal(input.packageName, "com.example.app");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "completed", content: "token=secret" }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-instrumentation-"));
    const timeline = new EvidenceTimeline(root);
    const provider = new MobileInstrumentationProvider({ baseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, apiKey: "test", deviceSerial: "emulator-5554", packageName: "com.example.app" });
    const event = await provider.capture(timeline, "tenant-a", "ENG-1", "appium.capture-network");
    assert.equal(event.kind, "request");
    assert.ok(event.content?.includes("[REDACTED]"));
    assert.ok(!event.content?.includes("token=secret"));
    await assert.rejects(() => provider.capture(timeline, "tenant-a", "ENG-1", "shell.exec" as never));
  });

  it("records worker commands in the optional timeline", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-worker-timeline-"));
    const timeline = new EvidenceTimeline(root);
    const worker = new AndroidDeviceWorker({ serial: "emulator-5554", packageName: "com.example.app", approved: true, timeline: { store: timeline, tenantId: "tenant-a", engagementId: "ENG-1" }, exec: async (args) => ({ code: 0, stdout: args.includes("get-state") ? "device" : "package:/data/app", stderr: "", timedOut: false }) });
    assert.equal((await worker.preflight()).status, "completed");
    assert.equal((await timeline.list("tenant-a", "ENG-1")).length, 2);
  });
});
