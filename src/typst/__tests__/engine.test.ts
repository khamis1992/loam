import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileTypst, systemFontDirs } from "../engine.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "typst-engine-"));

test("systemFontDirs: at least one real font directory on this machine", () => {
  const dirs = systemFontDirs().filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  assert.ok(dirs.length > 0, `no system font dirs found: ${systemFontDirs().join(", ")}`);
});

test("compileTypst: typesets math into a real PDF", () => {
  const mainPath = path.join(workspace, "paper.typ");
  fs.writeFileSync(mainPath, '#set document(title: "Probe")\n= Probe\n\n$ E = m c^2 $\n');
  const result = compileTypst({ mainPath, workspaceRoot: workspace });
  assert.equal(result.ok, true, `diagnostics: ${result.diagnostics.join(" | ")}`);
  assert.ok(result.pdf, "pdf bytes present");
  assert.equal(result.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.equal(result.pages, 1);
  assert.equal(result.title, "Probe");
});

test("compileTypst: reports diagnostics instead of throwing on a broken document", () => {
  const mainPath = path.join(workspace, "broken.typ");
  fs.writeFileSync(mainPath, "= Broken\n\n#nope()");
  const result = compileTypst({ mainPath, workspaceRoot: workspace });
  assert.equal(result.ok, false);
  assert.equal(result.pdf, null);
  assert.ok(result.diagnostics.length > 0, "diagnostics surfaced");
});

test("compileTypst: virtual sources resolve through the workspace", () => {
  const mainPath = path.join(workspace, "main.typ");
  fs.writeFileSync(mainPath, "= Main\n\n#include \"part.typ\"");
  const result = compileTypst({
    mainPath,
    workspaceRoot: workspace,
    sources: { "part.typ": "included chapter text" },
  });
  assert.equal(result.ok, true, `diagnostics: ${result.diagnostics.join(" | ")}`);
  assert.ok(result.pdf);
});

test("compileTypst: a missing main file fails with a diagnostic, never throws", () => {
  const result = compileTypst({ mainPath: path.join(workspace, "ghost.typ"), workspaceRoot: workspace });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.length > 0);
});
