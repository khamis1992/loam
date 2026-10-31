import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTypstTools } from "../typstTools.js";
import type { Tool, ToolContext } from "../registry.js";

function setup() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "typst-tools-"));
  const tools = new Map<string, Tool>(createTypstTools().map((t) => [t.name, t]));
  // Same construction as Loam's own tool tests (e.g. legalTools.test.ts).
  const ctx = { cfg: {}, emit: () => {}, workspace, taskId: "task-1" } as unknown as ToolContext;
  const tool = (name: string): Tool => {
    const t = tools.get(name);
    assert.ok(t, name);
    return t;
  };
  return { ctx, tool, workspace, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }) };
}

test("both typst tools are created with JSON-schema parameters", () => {
  const { tool, cleanup } = setup();
  for (const name of ["typst_compile", "typst_template"]) assert.equal(tool(name).parameters.type, "object");
  cleanup();
});

test("typst_compile: writes a real PDF next to the source", async () => {
  const { tool, ctx, workspace, cleanup } = setup();
  fs.writeFileSync(path.join(workspace, "doc.typ"), '#set document(title: "T")\n= T\n\n$ a^2 + b^2 = c^2 $\n');
  const r = await tool("typst_compile").run({ path: "doc.typ" }, ctx);
  assert.ok(r.ok, r.content);
  const pdf = path.join(workspace, "doc.pdf");
  assert.ok(fs.existsSync(pdf), "pdf written");
  assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString("latin1"), "%PDF-");
  assert.match(r.content, /doc\.pdf/);
  cleanup();
});

test("typst_compile: broken source surfaces diagnostics without writing a PDF", async () => {
  const { tool, ctx, workspace, cleanup } = setup();
  fs.writeFileSync(path.join(workspace, "bad.typ"), "#undefined_function()");
  const r = await tool("typst_compile").run({ path: "bad.typ" }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.content, /typst compile failed/);
  assert.ok(!fs.existsSync(path.join(workspace, "bad.pdf")));
  cleanup();
});

test("typst_compile: rejects non-.typ paths and paths outside the workspace", async () => {
  const { tool, ctx, cleanup } = setup();
  const notTyp = await tool("typst_compile").run({ path: "notes.txt" }, ctx);
  assert.equal(notTyp.ok, false);
  const outside = await tool("typst_compile").run({ path: "..\\..\\elsewhere.typ" }, ctx);
  assert.equal(outside.ok, false);
  const missing = await tool("typst_compile").run({ path: "ghost.typ" }, ctx);
  assert.equal(missing.ok, false);
  cleanup();
});

test("typst_template: every preset is compilable Typst source", async () => {
  const { tool, ctx, workspace, cleanup } = setup();
  for (const kind of ["paper", "thesis", "report", "homework"]) {
    const t = await tool("typst_template").run({ kind, title: "اختبار", author: "المؤلف" }, ctx);
    assert.ok(t.ok, kind);
    const file = path.join(workspace, `${kind}.typ`);
    fs.writeFileSync(file, t.content);
    const compiled = await tool("typst_compile").run({ path: `${kind}.typ` }, ctx);
    assert.ok(compiled.ok, `${kind}: ${compiled.content}`);
    assert.ok(fs.existsSync(path.join(workspace, `${kind}.pdf`)), `${kind} pdf written`);
  }
  cleanup();
});
