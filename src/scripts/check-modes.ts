import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry, type ToolContext } from "../tools/registry.js";
import { createLoamTools, parseCsv } from "../tools/loam.js";
import { getLoamMode, getLoamModesUi, LOAM_MODES } from "../modes/catalog.js";
import { resolveRead, resolveWrite } from "../policy/paths.js";
import { loadConfig } from "../config.js";
import { attachmentTools } from "../tools/attachments.js";
import { symbolTools } from "../tools/symbols.js";
import { browserTools } from "../tools/browser.js";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-modes-"));
const workspace = path.join(temp, "task-a"); const other = path.join(temp, "task-b");
fs.mkdirSync(workspace); fs.mkdirSync(other);
try {
  const cfg = loadConfig(); cfg.workspace = workspace; cfg.policy.allowOutsideWorkspaceRead = false;
  const ctx: ToolContext = { cfg, workspace, emit: () => {} };
  let executions = 0;
  const registry = new ToolRegistry();
  const all = new Set(LOAM_MODES.flatMap((mode) => mode.tools));
  for (const name of [...all, "delegate_subagent", "mcp__unknown__exec", "future_dangerous_tool"]) registry.register({ name, description: name, parameters: {}, run: async () => { executions++; return { ok: true, content: name }; } });
  for (const mode of LOAM_MODES) {
    const subset = registry.forMode(mode.id);
    assert.deepEqual(subset.names(), [...mode.tools].sort());
    assert.equal(subset.toOllama().length, mode.tools.length);
    for (const denied of registry.names().filter((name) => !mode.tools.includes(name))) {
      const before = executions;
      assert.equal((await subset.exec(denied, {}, ctx)).ok, false, `${mode.id} executed ${denied}`);
      assert.equal(executions, before);
      assert.equal(subset.cloneFiltered().get(denied), undefined);
    }
  }
  assert.throws(() => registry.forMode("unknown-mode"));
  assert.equal(registry.cloneFiltered({ allow: [] }).names().length, 0);
  assert.equal(getLoamMode("full").id, "build"); assert.equal(getLoamMode("discuss").id, "ask");
  assert.equal(new Set(LOAM_MODES.map((mode) => mode.tools.slice().sort().join(","))).size, LOAM_MODES.length);
  const ui = getLoamModesUi(["file_read"]);
  assert.ok(ui.available); assert.ok(ui.modes.every((mode) => mode.activeToolCount === 1 && mode.unavailableTools.length > 0));
  assert.throws(() => resolveRead(workspace, "../task-b/secret.txt", false));
  assert.throws(() => resolveWrite(workspace, "../task-b/new.txt"));
  fs.writeFileSync(path.join(other, "secret.txt"), "private");
  fs.symlinkSync(other, path.join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolveRead(workspace, "escape/secret.txt", false));
  assert.throws(() => resolveWrite(workspace, "escape/new/sub/file.txt"));
  assert.equal(resolveWrite(workspace, "new/sub/file.txt"), path.join(workspace, "new/sub/file.txt"));
  const readers = new ToolRegistry(); readers.registerAll([...attachmentTools(), ...symbolTools(), ...browserTools]);
  for (const name of ["file_extract_text", "file_view_image", "code_outline"]) {
    assert.equal((await readers.forMode("ask").exec(name, { path: "escape/secret.txt" }, ctx)).ok, false, `${name} escaped workspace`);
  }
  assert.equal((await readers.forMode("automate").exec("browser_open", { url: "file:///private.txt" }, ctx)).ok, false);
  const native = new ToolRegistry(); native.registerAll(createLoamTools());
  const documentResult = await native.forMode("write").exec("loam_document", { path: "report.html", format: "html", title: "<script>title</script>", content: "<img src=x onerror=alert(1)>" }, ctx);
  assert.equal(documentResult.ok, true, documentResult.content);
  const doc = fs.readFileSync(path.join(workspace, "report.html"), "utf8");
  assert.ok(doc.includes("&lt;script&gt;")); assert.ok(!doc.includes("<script>"));
  assert.equal((await native.forMode("ask").exec("loam_document", { path: "blocked.md" }, ctx)).ok, false);
  fs.writeFileSync(path.join(workspace, "data.csv"), 'name,value\r\n"a,b",2\r\n"multi\nline",4\r\nempty,\r\n');
  const dataset = await native.forMode("data").exec("loam_dataset", { path: "data.csv", output: "summary.json" }, ctx);
  assert.ok(dataset.ok); const parsed = JSON.parse(dataset.content);
  assert.equal(parsed.rows, 3); assert.equal(parsed.columns[1].mean, 3); assert.equal(parsed.columns[1].missing, 1);
  assert.deepEqual(parseCsv('a,b\n"a""b",2'), [["a", "b"], ['a"b', "2"]]);
  assert.throws(() => parseCsv('a\n"unclosed'));
  assert.equal((await native.forMode("data").exec("loam_dataset", { path: "escape/secret.txt" }, ctx)).ok, false);
  assert.equal((await native.forMode("media").exec("loam_canvas", { path: "poster.svg", title: "لوحة Loam", subtitle: "<unsafe>" }, ctx)).ok, true);
  assert.ok(fs.readFileSync(path.join(workspace, "poster.svg"), "utf8").includes("&lt;unsafe&gt;"));
  assert.equal((await native.forMode("media").exec("loam_canvas", { path: "../task-b/leak.svg", title: "No" }, ctx)).ok, false);
  assert.equal((await native.forMode("media").exec("loam_canvas", { path: "invalid.svg", title: "No", accent: '" onload="bad' }, ctx)).ok, false);
  console.log("PASS: seven distinct fail-closed modes, denied execution, native document/data/canvas outputs, realpath/junction isolation");
} finally {
  // Explicitly remove the junction before temp cleanup, never traverse its destination.
  const link = path.join(workspace, "escape"); if (fs.existsSync(link)) fs.unlinkSync(link);
  fs.rmSync(temp, { recursive: true, force: true });
}
