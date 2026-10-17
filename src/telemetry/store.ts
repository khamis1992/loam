import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../config.js";
import type { CritiqueResult, TelemetryRecord } from "../eval/types.js";

function telemetryDir(): string {
  const dir = path.join(DATA_DIR, "telemetry");
  fs.mkdirSync(path.join(dir, "transcripts"), { recursive: true });
  return dir;
}

const runsFile = (): string => path.join(telemetryDir(), "runs.jsonl");
const critiquesFile = (): string => path.join(telemetryDir(), "critiques.jsonl");
const transcriptsDir = (): string => path.join(telemetryDir(), "transcripts");

export function hashPrompt(prompt: string): string {
  return crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function readJsonl(file: string, limit: number): Record<string, unknown>[] {
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    const out: Record<string, unknown>[] = [];
    for (const line of lines.slice(-limit).reverse()) {
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function appendTelemetry(rec: TelemetryRecord): void {
  try {
    fs.appendFileSync(runsFile(), `${JSON.stringify(rec)}\n`, "utf8");
    const st = fs.statSync(runsFile());
    if (st.size > 5_000_000) {
      const lines = fs.readFileSync(runsFile(), "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
      fs.writeFileSync(runsFile(), `${lines.slice(-2000).join("\n")}\n`, "utf8");
    }
  } catch {
    /* telemetry is best-effort */
  }
}

export function readTelemetry(limit = 500): TelemetryRecord[] {
  return readJsonl(runsFile(), limit) as unknown as TelemetryRecord[];
}

export function appendCritique(rec: {
  at: string;
  runId: string;
  caseId: string;
  model: string;
  critique: CritiqueResult | null;
  raw?: string;
}): void {
  try {
    fs.appendFileSync(critiquesFile(), `${JSON.stringify(rec)}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

export function readCritiques(limit = 200): Array<Record<string, unknown>> {
  return readJsonl(critiquesFile(), limit);
}

export interface TranscriptData {
  prompt: string;
  finalText: string;
  messages: Array<{ role: string; content: string; tool_calls?: unknown; tool_name?: string; images?: string[] }>;
  trace: Array<{ name: string; ok: boolean; ms?: number }>;
  meta?: Record<string, unknown>;
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function saveTranscript(id: string, data: TranscriptData): string {
  const file = path.join(transcriptsDir(), `${safeId(id)}.json`);
  const clamped: TranscriptData = {
    prompt: data.prompt.slice(0, 4000),
    finalText: data.finalText.slice(0, 8000),
    messages: data.messages.slice(-80).map((m) => ({
      role: m.role,
      content: m.content.slice(0, 20_000),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_name ? { tool_name: m.tool_name } : {}),
      ...(m.images && m.images.length > 0 ? { images: [`<${m.images.length} image(s)>`] } : {}),
    })),
    trace: data.trace.slice(-60),
    meta: data.meta,
  };
  fs.writeFileSync(file, JSON.stringify(clamped), "utf8");
  pruneTranscripts();
  return file;
}

export function readTranscript(id: string): TranscriptData | null {
  try {
    const file = path.join(transcriptsDir(), `${safeId(id)}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as TranscriptData;
  } catch {
    return null;
  }
}

export function listTranscriptIds(limit = 1000): string[] {
  try {
    return fs
      .readdirSync(transcriptsDir())
      .filter((f) => f.endsWith(".json"))
      .slice(0, limit)
      .map((f) => f.slice(0, -".json".length));
  } catch {
    return [];
  }
}

function pruneTranscripts(keep = 300): void {
  try {
    const dir = transcriptsDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const { f } of files.slice(keep)) fs.unlinkSync(path.join(dir, f));
  } catch {
    /* best-effort */
  }
}

export interface TelemetrySummary {
  records: number;
  tasks: number;
  evalCases: number;
  tokens: { promptTokens: number; completionTokens: number };
  toolCalls: number;
  toolFailures: number;
  topFailingTools: Array<{ name: string; fails: number }>;
  lastAt: string | null;
}

export function telemetrySummary(): TelemetrySummary {
  const records = readTelemetry(5000);
  const failsByTool = new Map<string, number>();
  let toolCalls = 0;
  let toolFailures = 0;
  let tasks = 0;
  let evalCases = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let lastAt: string | null = null;
  for (const r of records) {
    if (r.kind === "task") tasks += 1;
    if (r.kind === "eval-case") evalCases += 1;
    promptTokens += r.usage?.promptTokens ?? 0;
    completionTokens += r.usage?.completionTokens ?? 0;
    for (const t of r.toolCalls ?? []) {
      toolCalls += 1;
      if (!t.ok) {
        toolFailures += 1;
        failsByTool.set(t.name, (failsByTool.get(t.name) ?? 0) + 1);
      }
    }
    if (r.at && (!lastAt || r.at > lastAt)) lastAt = r.at;
  }
  const topFailingTools = [...failsByTool.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, fails]) => ({ name, fails }));
  return { records: records.length, tasks, evalCases, tokens: { promptTokens, completionTokens }, toolCalls, toolFailures, topFailingTools, lastAt };
}
