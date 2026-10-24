/**
 * Audit-prompt eval (lleval harness, the §12.2-style prompt-quality measure).
 *
 * Runs the audit role prompts (recon / hunter / verifier / dedupe / critic)
 * against the real configured model and reports, per role, whether the model
 * honours the output contract those prompts demand: exactly one JSON object
 * with the role's required keys, no prose, no code fence.
 *
 * This script calls the real model, so it is a manual benchmark, not a unit
 * test (the suite definitions themselves are unit-tested with fakes in
 * src/security/native/__tests__/lleval.test.ts).
 *
 * Usage:
 *   npm run eval:audit-prompts
 *   npm run eval:audit-prompts -- --rubric --floor=0.8 --json
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { buildRuntime } from "../setup/runtime.js";
import { evaluateSuite, toJsonl } from "../security/native/lleval/index.js";
import { auditPromptSuites, callFromChat, graderFromChat } from "../security/audit/promptSuites.js";

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i] ?? "";
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}`) return "true";
  }
  return undefined;
}

async function main(): Promise<void> {
  const floor = Number(flag("floor") ?? 1);
  const rubric = flag("rubric") === "true";
  const cfg = loadConfig();
  const runtime = await buildRuntime(cfg, { mcp: false });
  try {
    const call = callFromChat(runtime.ollama, cfg.model);
    const grade = graderFromChat(runtime.ollama, cfg.model);
    const results = [];
    for (const suite of auditPromptSuites({ rubric })) {
      const r = await evaluateSuite(suite, call, rubric ? grade : undefined);
      const pct = `${(r.passRate * 100).toFixed(0)}%`;
      console.log(`suite=${r.name} cases=${r.total} pass=${r.passed} fail=${r.failed} passRate=${pct} avgLatencyMs=${r.avgLatencyMs}`);
      for (const c of r.cases.filter((x) => !x.pass)) {
        console.log(`  FAIL ${r.name}: ${c.reason.slice(0, 160)}`);
      }
      if (flag("out")) {
        const dir = flag("out")!;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${r.name}.jsonl`), toJsonl(r));
      }
      results.push({ suite: r.name, passRate: r.passRate, pass: r.passed, fail: r.failed, avgLatencyMs: r.avgLatencyMs });
    }
    if (flag("json")) console.log(JSON.stringify({ model: cfg.model, floor, results }, null, 2));
    const below = results.filter((r) => r.passRate < floor);
    process.exitCode = below.length === 0 ? 0 : 1;
  } finally {
    await runtime.dispose();
  }
}

main().catch((err) => {
  console.error(`eval:audit-prompts failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
