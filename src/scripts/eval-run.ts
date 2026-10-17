import { loadConfig } from "../config.js";
import { buildRuntime } from "../setup/runtime.js";
import { loadSuite } from "../eval/suites.js";
import { runSuiteLocked } from "../eval/service.js";
import type { ProgressEvent } from "../eval/runner.js";

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i] ?? "";
    if (a.startsWith(prefix)) return a.slice(prefix.length);
    if (a === `--${name}`) {
      const next = process.argv[i + 1];
      return next && !next.startsWith("--") ? next : "true";
    }
  }
  return undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ref = flag("suite") ?? cfg.evaluation.suite;
  const caseFilter = flag("case");
  const offline = has("offline");
  const json = has("json");
  const noCritique = has("no-critique") || !cfg.evaluation.critique;

  const rt = await buildRuntime(cfg, { mcp: has("mcp") });
  try {
    const suite = loadSuite(ref);
    const started = Date.now();
    const progress = (e: ProgressEvent): void => {
      if (json) return;
      if (e.phase === "case-start") process.stdout.write(`[${e.index}/${e.total}] ${e.caseId} ... `);
      if (e.phase === "case-done" && e.result) {
        const r = e.result;
        const mark = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : r.status.toUpperCase();
        const cpFail = r.checkpoints.find((c) => !c.ok);
        console.log(`${mark} (${(r.durationMs / 1000).toFixed(1)}s, ${r.steps} steps)${cpFail ? ` — ${cpFail.type}: ${cpFail.detail}` : ""}`);
      }
    };
    const run = await runSuiteLocked(
      suite,
      { cfg, ollama: rt.ollama, registry: rt.registry, critique: !noCritique, offline },
      { caseFilter, onProgress: progress },
    );
    if (json) {
      console.log(JSON.stringify(run, null, 2));
    } else {
      const s = run.summary;
      console.log("");
      console.log(`suite=${run.suiteId} run=${run.id} model=${run.model}`);
      console.log(`pass=${s.pass} fail=${s.fail} error=${s.error} skipped=${s.skipped} passRate=${(s.passRate * 100).toFixed(0)}%`);
      console.log(`duration=${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    process.exitCode = run.summary.fail + run.summary.error > 0 ? 1 : 0;
  } finally {
    await rt.dispose();
  }
}

main().catch((err) => {
  console.error(`eval failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
