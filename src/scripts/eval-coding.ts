/**
 * Coding-prompt eval (task C11).
 *
 * Runs the `coding-prompt` suite twice against the real configured model and reports
 * the pass rate with and without the coding section (Appendix C):
 *
 *   - before: LOAM_CODING_PROMPT=0 (master prompt, no coding section)
 *   - after:  default (master prompt + Appendix C for coding tasks)
 *
 * The suite is 10 SWE-style fixtures; each case's hidden verifier is a Node
 * script that fails on the untouched baseline (see
 * src/scripts/__tests__/eval-coding-fixtures.test.ts). This script calls the
 * real model, so it is a manual benchmark, not a unit test.
 *
 * Usage:
 *   npm run eval:coding
 *   npm run eval:coding -- --case=sum-array --json
 */
import { loadConfig } from "../config.js";
import { buildRuntime } from "../setup/runtime.js";
import { loadSuite } from "../eval/suites.js";
import { runSuiteLocked } from "../eval/service.js";

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i] ?? "";
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}`) {
      const next = process.argv[i + 1];
      return next && !next.startsWith("--") ? next : "true";
    }
  }
  return undefined;
}

interface RunSummary {
  label: string;
  passRate: number;
  pass: number;
  fail: number;
  error: number;
}

async function runOnce(
  label: string,
  coding: boolean,
  runtime: Awaited<ReturnType<typeof buildRuntime>>,
  caseFilter?: string,
): Promise<RunSummary> {
  if (coding) delete process.env.LOAM_CODING_PROMPT;
  else process.env.LOAM_CODING_PROMPT = "0";
  const suite = loadSuite("coding-prompt");
  const run = await runSuiteLocked(
    suite,
    { cfg: loadConfig(), ollama: runtime.ollama, registry: runtime.registry, critique: false, offline: true },
    { caseFilter },
  );
  const s = run.summary;
  return { label, passRate: s.passRate, pass: s.pass, fail: s.fail, error: s.error };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const caseFilter = flag("case");
  const runtime = await buildRuntime(cfg, { mcp: false });
  try {
    const before = await runOnce("before (no Appendix C)", false, runtime, caseFilter);
    const after = await runOnce("after (Appendix C)", true, runtime, caseFilter);
    const pct = (r: { passRate: number }): string => `${(r.passRate * 100).toFixed(0)}%`;
    console.log(`suite=coding-prompt model=${cfg.model} cases=${before.pass + before.fail + before.error}`);
    console.log(`${before.label}: pass=${before.pass} fail=${before.fail} error=${before.error} passRate=${pct(before)}`);
    console.log(`${after.label}: pass=${after.pass} fail=${after.fail} error=${after.error} passRate=${pct(after)}`);
    if (flag("json")) {
      console.log(JSON.stringify({ before, after }, null, 2));
    }
    process.exitCode = after.passRate >= before.passRate ? 0 : 1;
  } finally {
    await runtime.dispose();
  }
}

main().catch((err) => {
  console.error(`eval:coding failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
