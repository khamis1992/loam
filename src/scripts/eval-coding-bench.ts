/**
 * Coding benchmark CLI (C17).
 *
 * Compares the configured coders on the coding eval set (the C11 fixtures,
 * suite id "coding-prompt" by default) and writes a report listing the pass
 * rate per model. Usage:
 *
 *   npm run eval:coding-bench -- --suite=coding-prompt --json --out=data/coding-benchmark.json
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, loadConfig } from "../config.js";
import { buildRuntime } from "../setup/runtime.js";
import { loadSuite } from "../eval/suites.js";
import { runSuite, type EvalDeps } from "../eval/runner.js";
import { createProviderClient, providerModel, type FailoverProvider } from "../llm/failover.js";
import { codingProviders } from "../llm/codingRouter.js";
import {
  benchmarkCandidates,
  formatBenchmarkReport,
  runCodingBenchmark,
} from "../eval/codingBenchmark.js";
import type { EvalRun, EvalSuite } from "../eval/types.js";

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

function clientFor(provider: FailoverProvider | undefined, fallback: EvalDeps["ollama"]): EvalDeps["ollama"] {
  return (provider ? createProviderClient(provider) : fallback) as EvalDeps["ollama"];
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ref = flag("suite") ?? "coding-prompt";
  const caseFilter = flag("case");
  const offline = has("offline");
  const json = has("json");
  const explicitModels = flag("models");
  const out = flag("out") ?? path.join(DATA_DIR, "coding-benchmark.json");

  const suite: EvalSuite = loadSuite(ref);
  const rt = await buildRuntime(cfg, { mcp: has("mcp") });
  try {
    const env = process.env;
    const providers = codingProviders(cfg, env);
    const candidates = explicitModels
      ? explicitModels
          .split(/[,\s]+/)
          .map((m) => m.trim())
          .filter(Boolean)
          .map((model) => ({ model, providerId: providers.find((p) => p.model === model)?.id ?? "explicit" }))
      : benchmarkCandidates(cfg, env);

    const runSuiteForModel = async (
      model: string,
      providerId: string,
      targetSuite: EvalSuite,
      filter?: string,
    ): Promise<EvalRun> => {
      const provider = providers.find((p) => p.id === providerId);
      const deps: EvalDeps = {
        // Candidate models are configured coder ids; translate to the request
        // model the provider expects (cloud providers need the `:cloud` marker).
        cfg: { ...cfg, model: provider ? providerModel(provider) : model },
        ollama: clientFor(provider, rt.ollama),
        registry: rt.registry,
        critique: false,
        offline,
      };
      return runSuite({
        suite: targetSuite,
        deps,
        caseFilter: filter,
        onProgress: json
          ? undefined
          : (e) => {
              if (e.phase === "case-done" && e.result) {
                const mark = e.result.status === "pass" ? "PASS" : e.result.status.toUpperCase();
                process.stdout.write(`    ${e.caseId}: ${mark}\n`);
              }
            },
      });
    };

    const report = await runCodingBenchmark({
      cfg,
      suite,
      env,
      caseFilter,
      candidates,
      runSuiteForModel,
      onModelStart: json ? undefined : ({ model, index, total }) => process.stdout.write(`[${index}/${total}] ${model}\n`),
    });

    const markdown = formatBenchmarkReport(report);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
    fs.writeFileSync(`${out}.md`, markdown, "utf8");

    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(markdown);
      console.log(`report: ${out}`);
      console.log(`markdown: ${out}.md`);
    }
    process.exitCode = report.best ? 0 : 1;
  } finally {
    await rt.dispose();
  }
}

main().catch((err) => {
  console.error(`coding benchmark failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
