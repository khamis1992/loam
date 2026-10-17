import { loadConfig } from "../config.js";
import { exportDatasets } from "../eval/export.js";

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

async function main(): Promise<void> {
  const cfg = loadConfig();
  const outDir = flag("out");
  const result = await exportDatasets({ cfg, outDir });
  console.log(`datasets → ${result.dir}`);
  console.log(`  sft.jsonl:  ${result.sft} عينة`);
  console.log(`  pref.jsonl: ${result.pref} زوج preference`);
  console.log(`  manifest:   ${result.manifestPath}`);
}

main().catch((err) => {
  console.error(`export failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
