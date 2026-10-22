/**
 * Unit + acceptance tests for per-edit diagnostics (src/agent/diagnostics.ts).
 *
 * Guarantees under test:
 *  - settings are normalized and clamped
 *  - a successful edit to a TS/JS/py file runs a checker and appends findings
 *  - findings are capped at maxErrors and errors sort before warnings
 *  - the time budget is respected even when the checker never settles
 *  - disabled settings and unsupported extensions produce no outcome
 *  - config.json is overridable from LOAM.md
 *  - a real fixture with an introduced type error returns diagnostics in the
 *    file_edit result (acceptance), and the budget is honored (acceptance)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  DEFAULT_DIAGNOSTIC_SETTINGS,
  formatDiagnosticReport,
  normalizeDiagnosticSettings,
  readDiagnosticsFromMemory,
  resolveDiagnosticsSettings,
  runDiagnostics,
  type Diagnostic,
  type DiagnosticChecker,
  type DiagnosticSettings,
} from "../diagnostics.js";
import { fileTools } from "../../tools/files.js";
import type { ToolContext } from "../../tools/registry.js";

function fakeChecker(diagnostics: Diagnostic[], hang = false): DiagnosticChecker {
  return {
    name: "fake",
    supports: () => true,
    async check() {
      if (hang) await new Promise(() => {});
      return diagnostics;
    },
  };
}

function diag(partial: Partial<Diagnostic>): Diagnostic {
  return { file: "a.ts", line: 1, column: 1, severity: "error", message: "boom", code: "TS0000", ...partial };
}

function makeCtx(workspace: string, cfg?: Partial<DiagnosticSettings>): ToolContext {
  return {
    cfg: { diagnostics: cfg } as never,
    workspace,
    emit: () => {},
  };
}

describe("diagnostics settings", () => {
  it("normalizes and clamps settings", () => {
    assert.deepEqual(normalizeDiagnosticSettings(), DEFAULT_DIAGNOSTIC_SETTINGS);
    const clamped = normalizeDiagnosticSettings({ timeoutMs: 5, maxErrors: 9999, checker: "eslint" });
    assert.equal(clamped.timeoutMs, 1000);
    assert.equal(clamped.maxErrors, 100);
    assert.equal(clamped.checker, "eslint");
    assert.equal(normalizeDiagnosticSettings({ enabled: false }).enabled, false);
    assert.equal(normalizeDiagnosticSettings({ checker: "bogus" as never }).checker, "auto");
  });

  it("resolves config.json settings and lets LOAM.md win", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-diag-memory-"));
    try {
      fs.writeFileSync(
        path.join(dir, "LOAM.md"),
        ["## Diagnostics", "timeoutMs: 7000", "maxErrors: 5", "checker: eslint", "enabled: false", ""].join("\n"),
        "utf8",
      );
      const resolved = resolveDiagnosticsSettings(dir, {
        diagnostics: { timeoutMs: 3000, maxErrors: 2, checker: "tsc" },
      });
      assert.equal(resolved.timeoutMs, 7000);
      assert.equal(resolved.maxErrors, 5);
      assert.equal(resolved.checker, "eslint");
      assert.equal(resolved.enabled, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a fenced json diagnostics block from AGENTS.md", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-diag-fence-"));
    try {
      fs.writeFileSync(
        path.join(dir, "AGENTS.md"),
        ["# Project", "", "```json diagnostics", '{ "timeoutMs": 4321, "checker": "tsc" }', "```", ""].join("\n"),
        "utf8",
      );
      const parsed = readDiagnosticsFromMemory(dir);
      assert.equal(parsed.timeoutMs, 4321);
      assert.equal(parsed.checker, "tsc");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runDiagnostics", () => {
  it("returns sorted, capped findings from the injected checker", async () => {
    const settings: DiagnosticSettings = { enabled: true, timeoutMs: 5_000, maxErrors: 2, checker: "auto" };
    const outcome = await runDiagnostics(
      "a.ts",
      settings,
      fakeChecker([diag({ line: 9, severity: "warning" }), diag({ line: 2 }), diag({ line: 5 })]),
    );
    assert.ok(outcome);
    assert.equal(outcome!.checker, "fake");
    assert.equal(outcome!.total, 3);
    assert.equal(outcome!.diagnostics.length, 2);
    assert.equal(outcome!.diagnostics[0]!.line, 2, "errors sort before warnings");
    assert.equal(outcome!.diagnostics[1]!.line, 5);
    assert.equal(outcome!.timedOut, false);
  });

  it("respects the time budget when the checker never settles", async () => {
    const settings: DiagnosticSettings = { enabled: true, timeoutMs: 30, maxErrors: 20, checker: "auto" };
    const started = Date.now();
    const outcome = await runDiagnostics("a.ts", settings, fakeChecker([], true));
    const elapsed = Date.now() - started;
    assert.ok(outcome);
    assert.equal(outcome!.timedOut, true);
    assert.equal(outcome!.diagnostics.length, 0);
    assert.match(outcome!.note ?? "", /timed out after 30 ms/);
    assert.ok(elapsed < 2_000, `timeout was not respected (took ${elapsed} ms)`);
  });

  it("returns null when disabled", async () => {
    const settings: DiagnosticSettings = { enabled: false, timeoutMs: 5_000, maxErrors: 20, checker: "auto" };
    assert.equal(await runDiagnostics("a.ts", settings, fakeChecker([diag({})])), null);
  });

  it("returns null for an unsupported extension", async () => {
    const settings: DiagnosticSettings = { enabled: true, timeoutMs: 5_000, maxErrors: 20, checker: "auto" };
    assert.equal(await runDiagnostics("notes.md", settings), null);
  });

  it("reports a checker crash as a note instead of throwing", async () => {
    const settings: DiagnosticSettings = { enabled: true, timeoutMs: 5_000, maxErrors: 20, checker: "auto" };
    const crashing: DiagnosticChecker = {
      name: "crash",
      supports: () => true,
      async check() {
        throw new Error("boom");
      },
    };
    const outcome = await runDiagnostics("a.ts", settings, crashing);
    assert.ok(outcome);
    assert.equal(outcome!.timedOut, false);
    assert.match(outcome!.note ?? "", /checker failed: boom/);
  });
});

describe("formatDiagnosticReport", () => {
  it("renders a clean run", () => {
    const report = formatDiagnosticReport({
      file: "a.ts",
      checker: "tsc",
      diagnostics: [],
      total: 0,
      timedOut: false,
      elapsedMs: 12,
    });
    assert.match(report, /Diagnostics \(tsc, 12 ms\): no errors\./);
  });

  it("renders errors, warnings and truncation", () => {
    const diagnostics = Array.from({ length: 19 }, (_, i) => diag({ line: i + 1, message: `error ${i}` }));
    diagnostics.push(diag({ line: 99, severity: "warning", message: "late warning" }));
    const report = formatDiagnosticReport({
      file: "a.ts",
      checker: "tsc",
      diagnostics,
      total: 25,
      timedOut: false,
      elapsedMs: 40,
    });
    assert.match(report, /19 error\(s\), 1 warning\(s\)/);
    assert.match(report, /error 0/);
    assert.match(report, /… 5 more finding\(s\) not shown/);
  });
});

describe("file_edit diagnostics (acceptance)", () => {
  let dir = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-diag-fixture-"));
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            types: [],
          },
          include: ["a.ts"],
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "a.ts"), "export const n: number = 1;\n", "utf8");
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const editTool = (): ReturnType<typeof fileTools.find> => fileTools.find((t) => t.name === "file_edit");

  it("appends a type error to the edit result when one is introduced", async () => {
    const tool = editTool();
    assert.ok(tool, "file_edit tool is exported");
    const res = await tool!.run({ path: "a.ts", find: "= 1", replace: '= "x"' }, makeCtx(dir, { checker: "tsc" }));
    assert.equal(res.ok, true);
    assert.match(res.content, /replaced 1 occurrence/);
    assert.match(res.content, /Diagnostics \(tsc/);
    assert.match(res.content, /TS2322/);
    assert.match(res.content, /Type 'string' is not assignable to type 'number'/);
  });

  it("reports no errors for a clean edit", async () => {
    const tool = editTool();
    const res = await tool!.run({ path: "a.ts", find: "= 1", replace: "= 2" }, makeCtx(dir, { checker: "tsc" }));
    assert.equal(res.ok, true);
    assert.match(res.content, /replaced 1 occurrence/);
    assert.match(res.content, /Diagnostics \(tsc/);
    assert.match(res.content, /no errors/);
  });

  it("never lets the checker hang the edit past its budget", async () => {
    const tool = editTool();
    const started = Date.now();
    const res = await tool!.run(
      { path: "a.ts", find: "= 1", replace: "= 2" },
      makeCtx(dir, { checker: "tsc", timeoutMs: 1000 }),
    );
    const elapsed = Date.now() - started;
    assert.equal(res.ok, true);
    assert.ok(elapsed < 5_000, `edit took ${elapsed} ms despite a 1000 ms budget`);
  });
});
