import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvalSuite } from "../eval/types.js";
import type { RunOptions, RunResult } from "../agent/loop.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manus-eval-smoke-"));
process.env.MANUS_LOCAL_DATA_DIR = path.join(tmp, "data");
process.env.MANUS_LOCAL_EVALS_DIR = path.join(tmp, "evals");
process.env.MANUS_LOCAL_CONFIG = path.join(tmp, "config-none.json");

const { loadConfig } = await import("../config.js");
const { ToolRegistry } = await import("../tools/registry.js");
const { OllamaClient } = await import("../ollama.js");
const { runSuite } = await import("../eval/runner.js");
const { exportDatasets } = await import("../eval/export.js");
const { readTelemetry, readTranscript } = await import("../telemetry/store.js");
const { checkVerifier } = await import("../eval/verify.js");

const cfg = loadConfig();
cfg.workspace = path.join(tmp, "workspace");
fs.mkdirSync(cfg.workspace, { recursive: true });

const suite: EvalSuite = {
  id: "smoke",
  name: "Smoke",
  version: 1,
  cases: [
    {
      id: "pass-file",
      prompt: "اكتب ملف النجاح ok.txt",
      verify: [
        { type: "file_exists", path: "ok.txt" },
        { type: "file_contains", path: "ok.txt", text: "PASS" },
      ],
    },
    {
      id: "fail-file",
      prompt: "حالة تفشل: لا يكتب الستَب أي ملف",
      verify: [{ type: "file_exists", path: "missing.txt" }],
    },
    {
      id: "answer",
      prompt: "أجب بكلمة واحدة: ما عاصمة قطر؟",
      verify: [{ type: "answer_matches", pattern: "الدوحة" }],
    },
  ],
};

const stub =
  (write: boolean) =>
  async (opts: RunOptions): Promise<RunResult> => {
    opts.emit({ type: "step", index: 1 });
    opts.emit({ type: "tool_call", name: "file_write", args: { path: "ok.txt" } });
    if (write && opts.prompt.includes("ok.txt")) {
      fs.writeFileSync(path.join(opts.cfg.workspace, "ok.txt"), "PASS\n", "utf8");
      opts.emit({ type: "tool_result", name: "file_write", ok: true, summary: "wrote ok.txt", ms: 3 });
    } else {
      opts.emit({ type: "tool_result", name: "file_write", ok: true, summary: "noop", ms: 1 });
    }
    const text = opts.prompt.includes("عاصمة") ? "الدوحة" : "تم.";
    opts.emit({ type: "assistant_message", text });
    opts.emit({ type: "done", text, steps: 1, model: "stub" });
    return {
      text,
      steps: 1,
      model: "stub",
      messages: [
        { role: "system", content: "stub system" },
        { role: "user", content: opts.prompt },
        { role: "assistant", content: text },
      ],
      usage: { promptTokens: 12, completionTokens: 6, durationMs: 50 },
    };
  };

async function main(): Promise<void> {
  const ollama = new OllamaClient("http://127.0.0.1:1");
  const registry = new ToolRegistry();
  const checks: Array<[string, boolean]> = [];

  const run1 = await runSuite({ suite, deps: { cfg, ollama, registry, critique: false, runAgentFn: stub(true) } });
  checks.push(["run1: 2 pass / 1 fail", run1.summary.pass === 2 && run1.summary.fail === 1]);
  checks.push(["run1: answer case passes via regex", run1.cases.find((c) => c.id === "answer")?.status === "pass"]);
  checks.push(["run1: passFile checkpoints all ok", run1.cases.find((c) => c.id === "pass-file")?.checkpoints.every((p) => p.ok) === true]);

  const run2 = await runSuite({ suite, deps: { cfg, ollama, registry, critique: false, runAgentFn: stub(false) } });
  checks.push(["run2: pass-file now fails", run2.cases.find((c) => c.id === "pass-file")?.status === "fail"]);

  const dataDir = process.env.MANUS_LOCAL_DATA_DIR ?? "";
  checks.push(["run persisted to disk", fs.existsSync(path.join(dataDir, "evals", "runs", `${run1.id}.json`))]);
  checks.push(["run index written", fs.existsSync(path.join(dataDir, "evals", "index.jsonl"))]);

  const records = readTelemetry(100).filter((r) => r.kind === "eval-case");
  checks.push(["telemetry: 6 eval records", records.length === 6]);
  checks.push(["telemetry: has pass and fail", records.some((r) => r.passed === true) && records.some((r) => r.passed === false)]);
  checks.push(["telemetry: usage captured", records.every((r) => r.usage.promptTokens === 12 && r.usage.completionTokens === 6)]);

  const tr = readTranscript(`${run1.id}_answer`);
  checks.push(["transcript saved with messages", Boolean(tr && tr.messages.length >= 3 && tr.meta?.caseId === "answer")]);

  const exp = await exportDatasets({ cfg, outDir: path.join(tmp, "datasets") });
  checks.push(["export: sft >= 2 samples", exp.sft >= 2]);
  checks.push(["export: pref >= 1 pair", exp.pref >= 1]);
  checks.push([
    "export: files exist",
    fs.existsSync(path.join(exp.dir, "sft.jsonl")) && fs.existsSync(path.join(exp.dir, "pref.jsonl")) && fs.existsSync(exp.manifestPath),
  ]);

  const vctx = { workspace: cfg.workspace, finalText: "الدوحة", trace: [], cfg, ollama };
  const okExit = await checkVerifier({ type: "shell_exit", command: "exit 0" }, vctx);
  checks.push(["verifier: shell_exit 0", okExit.ok]);
  const badExit = await checkVerifier({ type: "shell_exit", command: "exit 3", exitCode: 3 }, vctx);
  checks.push(["verifier: shell_exit 3 expected 3", badExit.ok]);
  const escape = await checkVerifier({ type: "file_exists", path: "../escape.txt" }, vctx);
  checks.push(["verifier: path containment rejects escape", !escape.ok]);
  const badRe = await checkVerifier({ type: "answer_matches", pattern: "([" }, vctx);
  checks.push(["verifier: invalid regex fails cleanly", !badRe.ok]);
  const goodRe = await checkVerifier({ type: "answer_matches", pattern: "الدوحة" }, vctx);
  checks.push(["verifier: answer_matches positive", goodRe.ok]);

  console.log("");
  for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  const allOk = checks.every(([, ok]) => ok);
  console.log(`\neval harness smoke: ${allOk ? "PASS" : "FAIL"}  (tmp: ${tmp})`);
  if (!allOk) process.exit(1);
}

main().catch((err) => {
  console.error(`failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
