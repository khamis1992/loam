/**
 * End-to-end coding benchmark over the real C11 fixture set (C17).
 *
 * `codingBenchmark.test.ts` proves the aggregation math against a synthetic
 * suite. This test closes the other end of the acceptance criterion ("the eval
 * report lists a pass rate per model"): it loads the *real*
 * `evals/coding-prompt.json` fixtures, runs them through the *real* eval runner
 * with a scripted model, and checks that the benchmark report's per-model pass
 * rate reflects the real hidden verifiers.
 *
 * Everything runs offline: the model is a stub, so no API is contacted. The data
 * directory is redirected to a temp folder before the config module is imported,
 * so run history and telemetry never touch the repository.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-coding-bench-e2e-"));
// Must be set before `config.js` is first imported: DATA_DIR is a module-level
// constant, so anything importing it earlier would pin the real data folder.
process.env.MANUS_LOCAL_DATA_DIR = path.join(tmp, "data");
process.env.MANUS_LOCAL_EVALS_DIR = path.join(tmp, "evals");

const { runSuite } = await import("../runner.js");
const { runCodingBenchmark, formatBenchmarkReport } = await import("../codingBenchmark.js");
const { ToolRegistry } = await import("../../tools/registry.js");
const { OllamaClient } = await import("../../ollama.js");
const { loadSuite } = await import("../suites.js");
const { loadConfig } = await import("../../config.js");
// The eval runner imports `server/db.js`, whose `newId` lazily opens a SQLite
// file under DATA_DIR. Close it in `after()` so the temp data dir can be removed.
const { closeDb } = await import("../../server/sqliteStore.js");

import type { Config } from "../../config.js";
import type { RunOptions, RunResult } from "../../agent/loop.js";
import type { EvalSuite } from "../types.js";

let workspace = "";

before(() => {
  workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
});

after(() => {
  // Release the lazily-opened SQLite handle before deleting the temp data dir;
  // on Windows an open handle makes the directory removal fail with EPERM.
  closeDb();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    console.error(`[codingBenchmarkE2E] temp cleanup failed: ${String(err)}`);
  }
});

/** The real 10-case coding eval set from C11. */
function codingSuite(): EvalSuite {
  return loadSuite(path.join(ROOT, "evals", "coding-prompt.json"));
}

function cfg(): Config {
  const base = loadConfig();
  return {
    ...base,
    model: "stub-model",
    workspace,
    agent: { ...base.agent, maxSteps: 4 },
    evaluation: { ...base.evaluation, keepRuns: 0, transcripts: false },
    policy: { ...base.policy, networkEnabled: false },
  };
}

/**
 * Scripted model. `repair` makes it fix the off-by-one in the `sum-array`
 * fixture; otherwise it only reports progress. Both shapes leave the other nine
 * fixtures untouched, so their hidden verifiers fail exactly as on the baseline.
 */
function scriptedAgent(repair: boolean) {
  return async (opts: RunOptions): Promise<RunResult> => {
    const trace: Array<{ name: string; ok: boolean; ms?: number }> = [];
    opts.emit({ type: "step", index: 1 });
    opts.emit({ type: "tool_call", name: "file_read", args: { path: "index.js" } });

    const target = path.join(opts.cfg.workspace, "index.js");
    let fixed = false;
    if (repair && fs.existsSync(target)) {
      const before = fs.readFileSync(target, "utf8");
      // The fixture ships `for (let i = 1; ...)`, which skips the first element.
      const after = before.replace("for (let i = 1; i < nums.length; i++)", "for (let i = 0; i < nums.length; i++)");
      if (after !== before) {
        fs.writeFileSync(target, after, "utf8");
        fixed = true;
      }
    }

    trace.push({ name: "file_read", ok: true, ms: 1 });
    opts.emit({ type: "tool_result", name: "file_read", ok: true, summary: "read index.js", ms: 1 });
    if (fixed) {
      trace.push({ name: "file_write", ok: true, ms: 2 });
      opts.emit({ type: "tool_call", name: "file_write", args: { path: "index.js" } });
      opts.emit({ type: "tool_result", name: "file_write", ok: true, summary: "repaired index.js", ms: 2 });
    }

    const text = fixed ? "Repaired the off-by-one loop." : "Reviewed the code.";
    opts.emit({ type: "assistant_message", text });
    opts.emit({ type: "done", text, steps: 1, model: opts.cfg.model });
    return {
      text,
      steps: 1,
      model: opts.cfg.model,
      messages: [
        { role: "user", content: opts.prompt },
        { role: "assistant", content: text },
      ],
      usage: { promptTokens: 10, completionTokens: 5, durationMs: 2 },
    };
  };
}

describe("coding benchmark over the real C11 fixtures", () => {
  it("reports a pass rate per model from the real suite and verifiers", async () => {
    const suite = codingSuite();
    assert.equal(suite.cases.length, 10, "the real coding suite must keep its 10 cases");

    const ollama = new OllamaClient("http://127.0.0.1:1");
    const registry = new ToolRegistry();
    const base = cfg();

    const report = await runCodingBenchmark({
      cfg: base,
      suite,
      candidates: [
        { model: "strong-coder", providerId: "strong" },
        { model: "weak-coder", providerId: "weak" },
      ],
      runSuiteForModel: async (model, _providerId, targetSuite) =>
        runSuite({
          suite: targetSuite,
          deps: {
            cfg: { ...base, model },
            ollama,
            registry,
            critique: false,
            offline: true,
            runAgentFn: scriptedAgent(model === "strong-coder"),
          },
        }),
    });

    assert.equal(report.models.length, 2, "one report row per candidate model");
    assert.equal(report.suiteId, suite.id);

    const strong = report.models.find((m) => m.model === "strong-coder")!;
    const weak = report.models.find((m) => m.model === "weak-coder")!;

    // The strong coder repairs exactly one fixture; the weak one repairs none.
    // Every other case fails its real hidden verifier, exactly as on baseline.
    assert.equal(strong.total, 10);
    assert.equal(strong.pass, 1, `strong coder pass count (cases: ${JSON.stringify(strong.cases.map((c) => [c.caseId, c.status]))})`);
    assert.deepEqual(
      strong.cases.filter((c) => c.status === "pass").map((c) => c.caseId),
      ["sum-array"],
      "only the fixture the scripted model actually repaired may pass",
    );
    assert.ok(Math.abs(strong.passRate - 0.1) < 1e-9);
    assert.equal(weak.pass, 0);
    assert.equal(weak.passRate, 0);

    // The report is ordered by pass rate and names the strongest coder.
    assert.equal(report.models[0]!.model, "strong-coder");
    assert.deepEqual(report.best, { model: "strong-coder", passRate: 0.1, providerId: "strong" });

    // Every model row carries a numeric pass rate, as the acceptance criterion asks.
    assert.ok(report.models.every((m) => typeof m.passRate === "number" && Number.isFinite(m.passRate)));

    const markdown = formatBenchmarkReport(report);
    assert.match(markdown, /\| strong-coder \| strong \| 1 \| 9 \| 0 \| 0 \| 10 \| 10\.0% \|/);
    assert.match(markdown, /\| weak-coder \| weak \| 0 \| 10 \| 0 \| 0 \| 10 \| 0\.0% \|/);
    assert.match(markdown, /Best coder: \*\*strong-coder\*\*/);
  });

  it("keeps the real suite honest: an untouched baseline scores zero", async () => {
    const suite = codingSuite();
    const base = cfg();

    const report = await runCodingBenchmark({
      cfg: base,
      suite,
      candidates: [{ model: "no-op", providerId: "noop" }],
      runSuiteForModel: async (model, _providerId, targetSuite) =>
        runSuite({
          suite: targetSuite,
          deps: {
            cfg: { ...base, model },
            ollama: new OllamaClient("http://127.0.0.1:1"),
            registry: new ToolRegistry(),
            critique: false,
            offline: true,
            runAgentFn: scriptedAgent(false),
          },
        }),
    });

    const row = report.models[0]!;
    assert.equal(row.pass, 0, "a model that changes nothing must not pass any fixture");
    assert.equal(row.fail, 10);
    assert.equal(report.best, undefined, "no best coder when nothing passes");
  });
});
