import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rebrandTree } from "../../../electron/recorder/rebrand.mjs";

test("rebrand replaces OpenScreen and keeps the licence file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-recorder-rebrand-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<title>OpenScreen</title><h1>Openscreen</h1><p>project.openscreen OPENSCREEN_MCP_TOKEN</p><img src=\"openscreen-mark.png\">");
  fs.writeFileSync(path.join(dir, "openscreen-mark.png"), "png");
  fs.writeFileSync(path.join(dir, "LICENSE"), "OpenScreen contributors");
  const result = rebrandTree(dir);
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  assert.equal(html.includes("openscreen"), false);
  assert.match(html, /Loam Recorder/);
  assert.equal(html.includes("OPENSCREEN"), false);
  assert.match(html, /LOAMRECORDER_MCP_TOKEN/);
  assert.match(html, /\.loamrec/);
  assert.match(fs.readFileSync(path.join(dir, "LICENSE"), "utf8"), /OpenScreen/);
  assert.equal(result.leftover.length, 0);
  assert.equal(fs.existsSync(path.join(dir, "loamrecorder-mark.png")), true);
  assert.match(html, /loamrecorder-mark\.png/);
  fs.rmSync(dir, { recursive: true, force: true });
});
