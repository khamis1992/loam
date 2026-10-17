import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, type Config } from "../config.js";
import { readCritiques, readTelemetry, readTranscript, type TranscriptData } from "../telemetry/store.js";
import type { TelemetryRecord } from "./types.js";

export interface ExportResult {
  dir: string;
  sft: number;
  pref: number;
  manifestPath: string;
}

interface Sample {
  record: TelemetryRecord;
  transcript: TranscriptData;
}

function finalAssistant(s: Sample): string {
  const msgs = s.transcript.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "assistant" && m.content.trim()) return m.content;
  }
  return s.transcript.finalText;
}

function readmeText(manifest: { createdAt: string; source: { telemetryRecords: number; sftFrom: number; prefPairs: number }; models: string[] }): string {
  return [
    "# بيانات تدريب — تصدير تلقائي من manus-local",
    "",
    `- تاريخ التصدير: ${manifest.createdAt}`,
    `- موديلات المصدر: ${manifest.models.join(", ") || "-"}`,
    `- سجلات telemetry: ${manifest.source.telemetryRecords} • حالات SFT: ${manifest.source.sftFrom} • أزواج preference: ${manifest.source.prefPairs}`,
    "",
    "## sft.jsonl",
    "كل سطر: `{\"messages\": [...], \"meta\": {...}}` — مسار كامل (system/user/assistant/tool) من حالة تقييم ناجحة.",
    "",
    "## pref.jsonl",
    "كل سطر: `{\"prompt\", \"chosen\", \"rejected\", \"chosen_messages\", \"rejected_messages\", \"meta\"}` — من نفس حالة التقييم: مسار ناجح مقابل مسار فاشل، مع أسباب الفشل من الناقد في `meta.failureCauses`.",
    "",
    "## كيف تستخدمها",
    "- SFT: متوافق مع أي مدرب يقرأ صيغة OpenAI chat (Unsloth / Axolotl / LLaMA-Factory).",
    "- Preference (DPO/ORPO): استخدم `chosen`/`rejected` أو المسارات الكاملة.",
    "",
    "> ملاحظة: راجع البيانات يدوياً قبل التدريب — قد تحتوي نصوص مهام حساسة.",
  ].join("\n");
}

export async function exportDatasets(opts: { cfg: Config; outDir?: string }): Promise<ExportResult> {
  const records = readTelemetry(5000).filter((r) => r.kind === "eval-case" && r.runId && r.caseId);

  const critiqueCauses = new Map<string, string[]>();
  for (const c of readCritiques(2000)) {
    const runId = String(c.runId ?? "");
    const caseId = String(c.caseId ?? "");
    const crit = c.critique as { failureCauses?: unknown } | null | undefined;
    const causes = crit && Array.isArray(crit.failureCauses) ? crit.failureCauses.map((x) => String(x)) : [];
    if (runId && caseId && causes.length > 0) critiqueCauses.set(`${runId}_${caseId}`, causes);
  }

  const latestPass = new Map<string, Sample>();
  const latestFail = new Map<string, Sample>();
  for (const r of records) {
    const id = `${r.runId}_${r.caseId}`;
    const transcript = readTranscript(id);
    if (!transcript || transcript.messages.length === 0) continue;
    const sample: Sample = { record: r, transcript };
    const key = String(r.caseId);
    if (r.passed === true && !latestPass.has(key)) latestPass.set(key, sample);
    if (r.passed === false && !latestFail.has(key)) latestFail.set(key, sample);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = opts.outDir ? path.resolve(opts.outDir) : path.join(DATA_DIR, "datasets", stamp);
  fs.mkdirSync(dir, { recursive: true });

  const models = new Set<string>();
  const sftLines: string[] = [];
  for (const [caseId, s] of latestPass) {
    models.add(s.record.model);
    sftLines.push(
      JSON.stringify({
        messages: s.transcript.messages,
        meta: { caseId, runId: s.record.runId, model: s.record.model, at: s.record.at, steps: s.record.steps },
      }),
    );
  }

  const prefLines: string[] = [];
  for (const [caseId, pass] of latestPass) {
    const fail = latestFail.get(caseId);
    if (!fail) continue;
    const causes = critiqueCauses.get(`${fail.record.runId}_${caseId}`) ?? [];
    prefLines.push(
      JSON.stringify({
        prompt: pass.transcript.prompt,
        chosen: finalAssistant(pass),
        rejected: finalAssistant(fail),
        chosen_messages: pass.transcript.messages,
        rejected_messages: fail.transcript.messages,
        meta: { caseId, chosenRunId: pass.record.runId, rejectedRunId: fail.record.runId, failureCauses: causes },
      }),
    );
  }

  fs.writeFileSync(path.join(dir, "sft.jsonl"), sftLines.join("\n") + (sftLines.length > 0 ? "\n" : ""), "utf8");
  fs.writeFileSync(path.join(dir, "pref.jsonl"), prefLines.join("\n") + (prefLines.length > 0 ? "\n" : ""), "utf8");

  const manifest = {
    createdAt: new Date().toISOString(),
    source: { telemetryRecords: records.length, sftFrom: latestPass.size, prefPairs: prefLines.length },
    models: [...models],
    files: { sft: "sft.jsonl", pref: "pref.jsonl" },
  };
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "README.md"), readmeText(manifest), "utf8");

  return { dir, sft: sftLines.length, pref: prefLines.length, manifestPath };
}
