import path from "node:path";
import { loadConfig } from "../config.js";
import { OllamaClient } from "../ollama.js";
import { generateSelfPlayDraft } from "../learning/selfplay.js";

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
  const fromRunId = flag("run");
  const max = Number(flag("max"));

  const draft = await generateSelfPlayDraft({
    cfg,
    ollama: new OllamaClient(cfg.ollamaUrl),
    fromRunId,
    maxCases: Number.isFinite(max) && max > 0 ? max : undefined,
  });

  console.log(`draft → ${draft.draftPath}`);
  console.log(`suite: ${draft.suite.id} (${draft.suite.cases.length} حالة) من ${draft.sourceFailures.length} فشل`);
  for (const c of draft.suite.cases) console.log(`  - ${c.id}: ${c.prompt.slice(0, 160)}`);
  console.log("");
  console.log(`للتشغيل الآن:  npm run eval -- --suite ${path.basename(draft.draftPath)}`);
  console.log(`للاعتماد:      انسخها إلى مجلد evals/ أو استخدم زر الاعتماد في صفحة التعلّم.`);
}

main().catch((err) => {
  console.error(`selfplay failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
