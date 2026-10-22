/**
 * Unit tests for the Craft app availability status:
 *   - readCraftStatus reports installed/rev/source from each dist's .vendor.json
 *   - logMissingCraftDists warns (non-failing) when a dist is absent
 *   - GET /api/craft/status returns the same shape
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { after, before, describe, it } from "node:test";
import { readCraftStatus, logMissingCraftDists, CRAFT_APPS } from "../craftStatus.js";
import { handleCraftRoutes } from "../routes/craft.js";

function writeDist(root: string, app: string, vendor: Record<string, unknown>): void {
  const dist = path.join(root, "electron", "craft", app, "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(dist, ".vendor.json"), JSON.stringify({ app, ...vendor }));
}

let tmpDir = "";
let server: http.Server;
let base = "";

function listen(s: http.Server): Promise<string> {
  return new Promise((resolve) => {
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address() as import("node:net").AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

describe("craft status", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-craft-status-"));
    writeDist(tmpDir, "wordcraft", { rev: "abc123", sha256: "deadbeef", source: "cache" });
    server = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      void handleCraftRoutes(req, res, p, { root: tmpDir }).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    base = await listen(server);
  });

  after(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports installed apps and missing apps", () => {
    const status = readCraftStatus(tmpDir);
    assert.equal(status.length, CRAFT_APPS.length);
    const docs = status.find((s) => s.app === "wordcraft")!;
    assert.equal(docs.installed, true);
    assert.equal(docs.rev, "abc123");
    assert.equal(docs.source, "cache");
    assert.equal(docs.name, "Loam Docs");
    const sheets = status.find((s) => s.app === "gridcraft")!;
    assert.equal(sheets.installed, false);
    assert.equal(sheets.rev, null);
  });

  it("logs a non-failing warning for missing dists", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      logMissingCraftDists(tmpDir);
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /fetch-craft\.mjs/);
    assert.match(warnings[0]!, /gridcraft/);
  });

  it("serves GET /api/craft/status", async () => {
    const res = await fetch(base + "/api/craft/status");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { apps: Array<{ app: string; installed: boolean }> };
    assert.equal(body.apps.length, CRAFT_APPS.length);
    assert.equal(body.apps.find((a) => a.app === "wordcraft")!.installed, true);
  });

  it("404s unknown craft routes", async () => {
    const res = await fetch(base + "/api/craft/nope");
    assert.equal(res.status, 404);
  });
});
