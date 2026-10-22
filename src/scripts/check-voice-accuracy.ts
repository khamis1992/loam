/**
 * Voice transcription accuracy measurement (frontier section 13).
 * Generates Arabic audio samples (MSA + dialect phrases via espeak-ng),
 * transcribes them through the local STT server, and computes word-level
 * accuracy against the known ground truth.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "stt-accuracy-"));

// Test phrases: MSA (فصحى) + dialectal variations
const SAMPLES: Array<{ id: string; label: string; text: string; lang: string }> = [
  { id: "msa-001", label: "فصحى — جملة ترحيب", text: "مرحبا كيف حالك اليوم", lang: "ar" },
  { id: "msa-002", label: "فصحى — طلب عمل", text: "أريد إنشاء تقرير مفصل عن المبيعات", lang: "ar" },
  { id: "msa-003", label: "فصحى — سؤال تقني", text: "كيف أضيف صلاحيات جديدة للمساعد", lang: "ar" },
  { id: "dialect-001", label: "لهجة خليجية — تحية", text: "شلونك اليوم إن شاء الله بخير", lang: "ar" },
  { id: "dialect-002", label: "لهجة مصرية — طلب", text: "عايز أعمل عرض تقديمي للمشروع", lang: "ar" },
  { id: "dialect-003", label: "لهجة شامية — استفسار", text: "شو أخبار التطبيق الجديد", lang: "ar" },
  { id: "eng-001", label: "English — task", text: "Create a quarterly report with sales data", lang: "en" },
  { id: "mixed-001", label: "مختلط — عربي وإنجليزي", text: "افتح ال browser واعمل screenshot", lang: "ar" },
];

// Word-level accuracy (Levenshtein-inspired: matched words / total words)
function wordAccuracy(expected: string, actual: string): number {
  const expWords = expected.trim().split(/\s+/).filter(Boolean);
  const actWords = actual.trim().split(/\s+/).filter(Boolean);
  if (expWords.length === 0) return 0;
  // Simple matching: count how many expected words appear in the actual text
  const actLower = actual.toLowerCase();
  const matched = expWords.filter((w) => actLower.includes(w.toLowerCase()) || actLower.includes(w.slice(0, Math.max(2, w.length - 1))));
  return matched.length / expWords.length;
}

// STT server endpoint
declare const Bun: { spawn(cmd: string[], opts?: Record<string, unknown>): { stdout: unknown; stderr: unknown } };
const STT_URL = process.env.LOAM_STT_URL ?? "http://127.0.0.1:3947";

async function transcribe(audioPath: string): Promise<{ text: string; error?: string }> {
  const buf = fs.readFileSync(audioPath);
  const res = await fetch(`${STT_URL}/transcribe`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: buf });
  if (!res.ok) return { text: "", error: `HTTP ${res.status}` };
  const data = (await res.json()) as { segments?: Array<{ text: string }>; error?: string };
  if (data.error) return { text: "", error: data.error };
  return { text: (data.segments ?? []).map((s) => s.text).join(" ") };
}

console.log("Voice Transcription Accuracy Measurement (section 13)\n");
console.log(`STT server: ${STT_URL}`);
const health = await fetch(`${STT_URL}/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.log("STT server not running — starting...");
  // Start STT server
  const pyExe = path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python311", "python.exe");
  const proc = Bun.spawn([pyExe, "scripts/stt_server.py", "3947", "base"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  await new Promise((r) => setTimeout(r, 12000));
  const retry = await fetch(`${STT_URL}/health`).then((r) => r.json()).catch(() => null);
  if (!retry?.ok) {
    console.log("✗ STT server failed to start");
    process.exit(1);
  }
  console.log("STT server started\n");
}

const results: Array<{ id: string; label: string; expected: string; actual: string; accuracy: number }> = [];

for (const sample of SAMPLES) {
  // Generate audio via espeak-ng in WSL
  const wavPath = path.join(ws, `${sample.id}.wav`);
  const wslPath = wavPath.replace(/\\/g, "/").replace(/^([A-Z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`);
  try {
    execFileSync("wsl.exe", ["-d", "Ubuntu-24.04", "--", "espeak-ng", "-v", sample.lang, "-w", wslPath, sample.text], { timeout: 15000, windowsHide: true });
  } catch {
    console.log(`✗ ${sample.id}: audio generation failed`);
    results.push({ id: sample.id, label: sample.label, expected: sample.text, actual: "", accuracy: 0 });
    continue;
  }

  // Transcribe through STT server
  const result = await transcribe(wavPath);
  const accuracy = wordAccuracy(sample.text, result.text);

  results.push({ id: sample.id, label: sample.label, expected: sample.text, actual: result.text, accuracy });
  console.log(`${accuracy >= 0.5 ? "✔" : accuracy > 0 ? "◐" : "✗"} ${sample.label}: ${(accuracy * 100).toFixed(0)}% | expected: "${sample.text.slice(0, 30)}…" | got: "${result.text.slice(0, 30) || "(empty)"}"`);
}

// Summary by category
const msa = results.filter((r) => r.id.startsWith("msa-"));
const dialect = results.filter((r) => r.id.startsWith("dialect-"));
const mixed = results.filter((r) => r.id.startsWith("mixed-") || r.id.startsWith("eng-"));
const avg = (arr: typeof results) => arr.length ? arr.reduce((a, r) => a + r.accuracy, 0) / arr.length : 0;

console.log(`\n${"=".repeat(50)}`);
console.log(`فصحى (MSA):        ${(avg(msa) * 100).toFixed(0)}% (${msa.filter(r=>r.accuracy>=0.5).length}/${msa.length} passed)`);
console.log(`لهجات (Dialects):   ${(avg(dialect) * 100).toFixed(0)}% (${dialect.filter(r=>r.accuracy>=0.5).length}/${dialect.length} passed)`);
console.log(`مختلط/إنجليزي:      ${(avg(mixed) * 100).toFixed(0)}% (${mixed.filter(r=>r.accuracy>=0.5).length}/${mixed.length} passed)`);
console.log(`الإجمالي:           ${(avg(results) * 100).toFixed(0)}% (${results.filter(r=>r.accuracy>=0.5).length}/${results.length} passed ≥50%)`);

// Save evidence
const evidence = {
  suite: "voice-transcription-accuracy",
  at: new Date().toISOString(),
  sttEngine: "faster-whisper base int8 CPU",
  note: "Arabic MSA + dialectal phrases generated via espeak-ng, transcribed through the local STT server. Word-level accuracy computed against ground truth.",
  categories: {
    msa: { accuracy: Number(avg(msa).toFixed(3)), passed: msa.filter(r=>r.accuracy>=0.5).length, total: msa.length },
    dialects: { accuracy: Number(avg(dialect).toFixed(3)), passed: dialect.filter(r=>r.accuracy>=0.5).length, total: dialect.length },
    mixed: { accuracy: Number(avg(mixed).toFixed(3)), passed: mixed.filter(r=>r.accuracy>=0.5).length, total: mixed.length },
  },
  overallAccuracy: Number(avg(results).toFixed(3)),
  results,
};
fs.writeFileSync(path.resolve(import.meta.dirname, "../../docs/evidence/voice-accuracy.json"), JSON.stringify(evidence, null, 1));
console.log(`\nevidence → docs/evidence/voice-accuracy.json`);
