/**
 * LIVE benchmark (section 24): the fixed AR/EN suite scored with a REAL model —
 * correctness against real side effects, interventions counted from approval
 * requests, results exported to docs/evidence/companions-bench-live.json so a
 * model/tool/skill update can be checked for quality regressions with the live
 * stack. Opt-in like check:swarm-live: LOAM_COMPANIONS_MODEL selects the model.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-live-bench-"));
const tagsRes = await fetch("http://127.0.0.1:11434/api/tags").catch(() => null);
if (!tagsRes?.ok) {
  console.log("SKIPPED: no reachable Ollama at 127.0.0.1:11434 (live bench is opt-in evidence).");
  process.exit(0);
}
const names = ((await tagsRes.json()) as { models: Array<{ name: string }> }).models.map((m) => m.name);
if (names.length === 0) {
  console.log("SKIPPED: Ollama reachable but no models installed.");
  process.exit(0);
}
const wanted = process.env.LOAM_COMPANIONS_MODEL;
const model = (wanted && names.includes(wanted)) || wanted ? wanted! : names.find((n) => !n.includes("embed")) ?? names[0]!;
console.log(`live bench model: ${model}`);

const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>((r) => probe.close(() => r()));
const base = `http://127.0.0.1:${port}`;
const config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({ model, fallbackModel: model, ollamaUrl: "http://127.0.0.1:11434", workspace: path.join(tmp, "ws"), memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, orchestrator: { enabled: false }, mcpServers: {} }));
fs.mkdirSync(path.join(tmp, "ws"), { recursive: true });
let child: ChildProcess | undefined;
let logs = "";
child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: root, windowsHide: true,
  env: { ...process.env, MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: path.join(tmp, "data"), MANUS_LOCAL_PORT: String(port), MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills") },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout?.on("data", (c) => { logs += c; }); child.stderr?.on("data", (c) => { logs += c; });
{
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (child?.exitCode != null) throw new Error(logs);
    if (await fetch(`${base}/api/work-modes`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const stop = async (): Promise<void> => {
  if (child && child.exitCode === null) { const e = once(child, "exit"); child.kill("SIGKILL"); await e; }
};

type Ev = Record<string, unknown>;
const runChat = async (body: Record<string, unknown>, timeoutMs = 6 * 60_000): Promise<Ev[]> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify(body) });
    const events: Ev[] = [];
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
        buf = buf.slice(i + 2);
        if (!line) continue;
        try { events.push(JSON.parse(line.slice(6)) as Ev); } catch { /* skip */ }
        const last = events.at(-1);
        if (last?.type === "done" || last?.type === "error") { void reader.cancel().catch(() => null); }
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
};

interface LiveCase {
  id: string;
  lang: "ar" | "en";
  mode: string;
  prompt: string;
  verify: (taskId: string) => Promise<string>;
}

const wsOf = (taskId: string) => path.join(tmp, "ws", ".loam-tasks", taskId);

try {
  const agentRes = await fetch(`${base}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "المقيس الحي", mode: "build", instructions: "نفّذ أدوات المهمة حرفيًا كما تُطلب ثم أجب بإيجاز. عند إنشاء مستند استخدم المسار المحدد في الطلب." }) });
  const agent = ((await agentRes.json()) as { agent: { id: string } }).agent;

  const cases: LiveCase[] = [
    {
      id: "doc-ar", lang: "ar", mode: "write",
      prompt: "أنشئ مستندًا بالاسم report-ar.md عنوانه «تقرير الربع» ومحتواه سطر واحد: نمت الإيرادات 12 بالمئة هذا الربع. احفظه ثم أجب: تم.",
      verify: async (taskId) => {
        const p2 = path.join(wsOf(taskId), "report-ar.md");
        if (!fs.existsSync(p2)) return "document missing";
        return fs.readFileSync(p2, "utf8").includes("12") ? "" : "content wrong";
      },
    },
    {
      id: "memory-ar", lang: "ar", mode: "build",
      prompt: "احفظ في ذاكرتك الشخصية أنني أفضّل الأمثلة قبل التعريفات، ثم أجب: تم.",
      verify: async () => {
        const { entries } = (await (await fetch(`${base}/api/agents/${encodeURIComponent(agent.id)}/memory`)).json()) as { entries: Array<{ text: string }> };
        return entries.some((e) => e.text.includes("الأمثلة") || e.text.includes("أمثلة")) ? "" : "preference not saved";
      },
    },
    {
      id: "task-en", lang: "en", mode: "build",
      prompt: "Create a task titled 'Quarterly infrastructure audit' (do not run it), then reply: done.",
      verify: async () => {
        const { tasks } = (await (await fetch(`${base}/api/tasks?agentId=${encodeURIComponent(agent.id)}`)).json()) as { tasks: Array<{ title: string }> };
        return tasks.some((t) => (t.title ?? "").toLowerCase().includes("infrastructure audit")) ? "" : "task not created/owned";
      },
    },
  ];

  const results: Array<{ id: string; lang: string; pass: boolean; reason: string; ms: number; toolCalls: number; interventions: number; modelReply: string }> = [];
  for (const c of cases) {
    const started = Date.now();
    const events = await runChat({ prompt: c.prompt, agentId: agent.id, mode: c.mode, title: `live-bench ${c.id}` });
    const taskId = String((events.find((e) => e.type === "task") as { taskId?: string } | undefined)?.taskId ?? "");
    const toolCalls = events.filter((e) => e.type === "tool_call").map((e) => String(e.name));
    const interventions = events.filter((e) => e.type === "approval_required").length;
    const doneOk = events.some((e) => e.type === "done");
    const failure = !doneOk
      ? `run error: ${JSON.stringify(events.find((e) => e.type === "error")).slice(0, 200)}`
      : await c.verify(taskId);
    const reply = String((events.findLast((e) => e.type === "assistant_message") as { text?: string } | undefined)?.text ?? "").slice(0, 120);
    results.push({ id: c.id, lang: c.lang, pass: failure === "", reason: failure || "ok", ms: Date.now() - started, toolCalls: toolCalls.length, interventions, modelReply: reply });
    console.log(`${failure === "" ? "✔" : "✗"} ${c.id} (${c.lang}) ${failure === "" ? "pass" : failure} | tools=${toolCalls.join(",") || "-"} | ${(Date.now() - started) / 1000 | 0}s | reply="${reply.slice(0, 60)}"`);
  }
  const passed = results.filter((r) => r.pass).length;
  const summary = {
    suite: `companions-bench-live v1 (model=${model})`,
    at: new Date().toISOString(),
    model,
    total: results.length,
    passed,
    completionRate: Number((passed / results.length).toFixed(3)),
    totalInterventions: results.reduce((a, r) => a + r.interventions, 0),
    wallMs: results.reduce((a, r) => a + r.ms, 0),
    results,
  };
  const evidenceDir = path.resolve(import.meta.dirname, "../../docs/evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "companions-bench-live.json"), JSON.stringify(summary, null, 1));
  console.log(`LIVE bench (${model}): ${passed}/${results.length} pass | completion=${(summary.completionRate * 100).toFixed(0)}% | interventions=${summary.totalInterventions} | exported docs/evidence/companions-bench-live.json`);
  // A live gate: at least the memory + task cases should pass with any decent
  // model; document-ar depends on model tool fidelity. Require >= 2/3.
  assert.ok(passed >= 2, `live bench minimum 2/3 not met — see docs/evidence/companions-bench-live.json`);
} finally {
  await stop();
}
