import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import { appendLearning } from "../server/learning.js";
import { getRun, listRuns } from "../eval/store.js";
import { draftsDir } from "../eval/suites.js";
import type { EvalCase, EvalSuite, VerifierSpec } from "../eval/types.js";

export interface SelfPlayResult {
  draftPath: string;
  suite: EvalSuite;
  sourceFailures: string[];
}

const SELFPLAY_SYSTEM = [
  "You design evaluation tasks for a local autonomous desktop agent (files, shell, web, computer-use).",
  "You receive failed evaluation tasks with their failure causes. Produce NEW tasks that test the SAME weaknesses from different angles.",
  "Return ONLY JSON:",
  '{"cases":[{"id":"short-slug","prompt":"task in the SAME LANGUAGE as the originals","setup":[{"type":"write_file","path":"fixture.txt","text":"..."}],"verify":[{"type":"file_exists","path":"out.txt"},{"type":"answer_matches","pattern":"..."}],"tags":["generated"]}]}',
  "Verifier types and their exact fields:",
  "- file_exists / file_absent: {type, path}",
  "- file_contains: {type, path, text}  (literal substring)",
  "- file_matches: {type, path, pattern}  (regex on file content)",
  "- shell_exit: {type, command, exitCode?} • shell_contains: {type, command, text}",
  "- http_ok: {type, url, jsonPath?} • tool_used: {type, name, expectOk?}",
  "- answer_matches: {type, pattern, flags?}  (regex on the final answer)",
  "- llm_judge: {type, rubric}",
  "Rules:",
  "- Prefer deterministic verifiers; use llm_judge ONLY when no deterministic check is possible.",
  "- Keep tasks self-contained inside an empty sandbox workspace.",
  "- Do not copy the original prompts; change the scenario while keeping the tested skill identical.",
].join("\n");

function parseCases(text: string): unknown[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { cases?: unknown };
    return Array.isArray(parsed.cases) ? parsed.cases : [];
  } catch {
    return [];
  }
}

function normalizeVerifier(raw: unknown): VerifierSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const str = (k: string): string | undefined => {
    const v = s[k];
    return typeof v === "string" && v.trim() ? v : undefined;
  };
  const type = typeof s.type === "string" ? s.type : "";
  switch (type) {
    case "file_exists":
    case "file_absent": {
      const p = str("path");
      return p ? { type, path: p } : null;
    }
    case "file_contains": {
      const p = str("path");
      if (!p) return null;
      const text = str("text");
      if (text) return { type: "file_contains", path: p, text };
      const pattern = str("pattern") ?? str("regex");
      return pattern ? { type: "file_matches", path: p, pattern } : null;
    }
    case "file_matches": {
      const p = str("path");
      const pattern = str("pattern") ?? str("regex");
      return p && pattern ? { type: "file_matches", path: p, pattern } : null;
    }
    case "shell_exit": {
      const command = str("command");
      if (!command) return null;
      const exitCode = typeof s.exitCode === "number" ? s.exitCode : undefined;
      return { type: "shell_exit", command, ...(exitCode !== undefined ? { exitCode } : {}) };
    }
    case "shell_contains": {
      const command = str("command");
      const text = str("text");
      return command && text ? { type: "shell_contains", command, text } : null;
    }
    case "http_ok": {
      const url = str("url");
      if (!url) return null;
      const jsonPath = str("jsonPath");
      return { type: "http_ok", url, ...(jsonPath ? { jsonPath } : {}) };
    }
    case "tool_used": {
      const name = str("name") ?? str("tool");
      if (!name) return null;
      const expectOk = typeof s.expectOk === "boolean" ? s.expectOk : undefined;
      const minCount = typeof s.minCount === "number" ? s.minCount : undefined;
      return {
        type: "tool_used",
        name,
        ...(expectOk !== undefined ? { expectOk } : {}),
        ...(minCount !== undefined ? { minCount } : {}),
      };
    }
    case "answer_matches": {
      const pattern = str("pattern");
      if (!pattern) return null;
      const flags = str("flags");
      return { type: "answer_matches", pattern, ...(flags ? { flags } : {}) };
    }
    case "llm_judge": {
      const rubric = str("rubric");
      return rubric ? { type: "llm_judge", rubric } : null;
    }
    default:
      return null;
  }
}

function validVerifiers(v: unknown): VerifierSpec[] {
  if (!Array.isArray(v)) return [];
  const out: VerifierSpec[] = [];
  for (const spec of v) {
    const normalized = normalizeVerifier(spec);
    if (normalized) out.push(normalized);
  }
  return out;
}

function coerceCase(raw: unknown, index: number): EvalCase | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const prompt = typeof r.prompt === "string" ? r.prompt.trim() : "";
  if (!prompt) return null;
  const id = (typeof r.id === "string" && r.id.trim() ? r.id.trim() : `gen-${index + 1}`).replace(/[^A-Za-z0-9._-]/g, "-");
  const setup = Array.isArray(r.setup)
    ? r.setup
        .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === "object"))
        .filter((s) => s.type === "write_file" && typeof s.path === "string" && typeof s.text === "string")
        .map((s) => ({ type: "write_file" as const, path: String(s.path), text: String(s.text) }))
    : undefined;
  let verify = validVerifiers(r.verify);
  if (verify.length === 0) {
    verify = [{ type: "llm_judge", rubric: `المهمة: ${prompt}\nيجب أن يكون الناتج النهائي صحيحاً وكاملاً ومطابقاً للمطلوب.` }];
  }
  const tags = Array.isArray(r.tags) ? r.tags.map((t) => String(t)).slice(0, 5) : ["generated"];
  return { id, prompt, ...(setup && setup.length > 0 ? { setup } : {}), verify, tags };
}

export async function generateSelfPlayDraft(opts: {
  cfg: Config;
  ollama: OllamaClient;
  fromRunId?: string;
  maxCases?: number;
}): Promise<SelfPlayResult> {
  const max = Math.min(Math.max(opts.maxCases ?? opts.cfg.selfPlay.maxCases, 1), 20);

  const failures: Array<{ caseId: string; prompt: string; causes: string[]; status: string }> = [];
  if (opts.fromRunId) {
    const run = getRun(opts.fromRunId);
    if (!run) throw new Error(`run غير موجود: ${opts.fromRunId}`);
    for (const c of run.cases) {
      if (c.status !== "pass") failures.push({ caseId: c.id, prompt: c.prompt, causes: c.critique?.failureCauses ?? [], status: c.status });
    }
  } else {
    for (const s of listRuns(10)) {
      if (s.status === "running") continue;
      const run = getRun(s.id);
      if (!run) continue;
      for (const c of run.cases) {
        if (c.status !== "pass" && c.prompt) failures.push({ caseId: c.id, prompt: c.prompt, causes: c.critique?.failureCauses ?? [], status: c.status });
      }
      if (failures.length >= 8) break;
    }
  }

  const deduped: typeof failures = [];
  const seen = new Set<string>();
  for (const f of failures) {
    if (seen.has(f.caseId)) continue;
    seen.add(f.caseId);
    deduped.push(f);
  }
  const sources = deduped.slice(0, 8);
  if (sources.length === 0) throw new Error("لا توجد حالات فاشلة — نفّذ تقييماً أولاً");

  const userDigest = [
    `Generate exactly ${max} new evaluation cases.`,
    "",
    "FAILED TASKS:",
    ...sources.map(
      (f, i) => `${i + 1}. [${f.status}] ${f.prompt.slice(0, 400)}${f.causes.length > 0 ? `\n   causes: ${f.causes.join("; ").slice(0, 300)}` : ""}`,
    ),
  ].join("\n");

  const result = await opts.ollama.chat({
    model: opts.cfg.selfImprove.model || opts.cfg.model,
    messages: [
      { role: "system", content: SELFPLAY_SYSTEM },
      { role: "user", content: userDigest },
    ],
    temperature: 0.4,
    timeoutMs: 300_000,
  });

  const cases: EvalCase[] = [];
  for (const [i, raw] of parseCases(result.content).entries()) {
    const c = coerceCase(raw, i);
    if (c) cases.push(c);
  }
  if (cases.length === 0) throw new Error("فشل توليد حالات صالحة من مخرجات الموديل");
  const finalCases = cases.slice(0, max);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const suite: EvalSuite = {
    id: `selfplay-${stamp}`,
    name: `حالات مولّدة من الفشل — ${stamp}`,
    version: 1,
    cases: finalCases,
  };
  const fileName = `selfplay-${stamp}.json`;
  const draftPath = path.join(draftsDir(), fileName);
  fs.writeFileSync(draftPath, JSON.stringify(suite, null, 2), "utf8");

  appendLearning({
    at: new Date().toISOString(),
    task: `(self-play) ${sources.length} حالات فاشلة → ${finalCases.length} حالة جديدة`,
    applied: [fileName],
  });
  log.info(`self-play: draft ${draftPath} (${finalCases.length} cases)`);

  return { draftPath, suite, sourceFailures: sources.map((f) => f.caseId) };
}
