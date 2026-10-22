/**
 * Companions benchmark (frontier stage 6, section 24): a FIXED Arabic/English
 * task suite measuring result correctness (verified against real side effects,
 * not the model's claims), completion rate, user interventions (approval
 * requests raised), and wall time. Deterministic stub model + fake devices;
 * the suite, scorer and metrics are versioned so quality regressions after a
 * model/tool/skill update are detectable. Results export to docs/evidence.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const SUITE_VERSION = "companions-bench v1 (2026-10-18)";
const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-bench-"));
let approvalsRaised = 0;

const model = http.createServer(async (req, res) => {
  if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "test-model" }] })); return; }
  let raw = ""; for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  const messages = body.messages as Array<{ role: string; content: string }>;
  const system = messages[0]?.content ?? "";
  const userPrompt = messages.findLast((m) => m.role === "user")?.content ?? "";
  const afterTool = messages.at(-1)?.role === "tool";
  const isVerifier = (messages[0]?.content ?? "").includes("verifier role") || String(body.system ?? "").includes("verifier role") || messages.some((m) => m.role === "user" && String(m.content).includes("Judge now"));
  if (isVerifier) {
    await new Promise((r) => setTimeout(r, 50));
    const sawTool = messages.some((m) => m.role === "tool");
    const payload = sawTool
      ? { role: "assistant", content: '{"verdict": "pass", "reason": "inspected the workspace with read-only tools; result matches the request", "fixes": []}' }
      : { role: "assistant", content: "", tool_calls: [{ function: { name: "file_list", arguments: { path: "." } } }] };
    res.setHeader("content-type", "application/x-ndjson");
    res.end(JSON.stringify({ model: "test-model", message: payload, done: true }) + "\n");
    return;
  }
  const call = (name: string, args: Record<string, unknown>) => ({ role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] });
  let payload: { role: string; content: string; tool_calls?: unknown[] };
  if (userPrompt.includes("BENCH-DOC-AR") && !afterTool) payload = call("loam_document", { path: "bench-report-ar.md", title: "تقرير الربع", content: "إيرادات الربع ارتفعت 12% مدفوعة بقطاع المؤسسات." });
  else if (userPrompt.includes("BENCH-MEM-AR") && !afterTool) payload = call("companion_memory_save", { text: "يفضّل المستخدم الجداول قبل النص في التقارير", kind: "preference", source: "user", confidence: 0.9 });
  else if (userPrompt.includes("BENCH-TASK-EN") && !afterTool) payload = call("task_create", { title: "Quarterly infrastructure audit" });
  else if (userPrompt.includes("BENCH-DATA-EN") && !afterTool) payload = call("file_write", { path: "bench.csv", content: "city,sales\nRiyadh,120\nJeddah,80\nDammam,40\n" });
  else if (userPrompt.includes("BENCH-DATA-EN") && messages.filter((m) => m.role === "tool").length === 1) payload = call("loam_dataset", { path: "bench.csv" });
  else if (userPrompt.includes("BENCH-DEVICE-AR") && !afterTool) payload = call("device_write_file", { path: "/home/loam/bench.md", content: "ناتج القياس داخل الجهاز المستقل" });
  else if (userPrompt.includes("BENCH-DEVICE-AR") && messages.filter((m) => m.role === "tool").length === 1) payload = call("device_pull_file", { path: "/home/loam/bench.md" });
  else if (userPrompt.includes("BENCH-DELEGATE-EN") && !afterTool) payload = call("companion_delegate", { to: "المدقق الإنجليزي", brief: "Review the audit checklist and sign off", title: "Audit sign-off" });
  else if (system.includes("المدقق الإنجليزي")) payload = { role: "assistant", content: "Signed off." };
  else payload = { role: "assistant", content: "تم" };
  res.setHeader("content-type", "application/x-ndjson");
  res.end(JSON.stringify({ model: "test-model", message: payload, done: true }) + "\n");
});
model.listen(0, "127.0.0.1"); await once(model, "listening");
const modelPort = (model.address() as import("node:net").AddressInfo).port;
const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>((r) => probe.close(() => r()));
const base = `http://127.0.0.1:${port}`;
const config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({
  model: "test-model", fallbackModel: "test-model", ollamaUrl: `http://127.0.0.1:${modelPort}`,
  workspace: path.join(tmp, "ws"), computerUse: { enabled: true, screenshotDir: path.join(tmp, "shots") },
  memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false },
  orchestrator: { enabled: false }, mcpServers: {},
}));
fs.mkdirSync(path.join(tmp, "ws"), { recursive: true });
let child: ChildProcess | undefined;
let logs = "";
const start = async (): Promise<void> => {
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: root, windowsHide: true,
    env: { ...process.env, MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: path.join(tmp, "data"), MANUS_LOCAL_PORT: String(port), MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills"), LOAM_DEVICE_RUNNER: "fake" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c) => { logs += c; }); child.stderr?.on("data", (c) => { logs += c; });
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (child?.exitCode != null) throw new Error(logs);
    if (await fetch(`${base}/api/work-modes`).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`startup timeout\n${logs.slice(-1500)}`);
};
const stop = async (): Promise<void> => {
  if (child && child.exitCode === null) { const e = once(child, "exit"); child.kill("SIGKILL"); await e; }
  await new Promise<void>((r) => model.close(() => r()));
};
type Ev = Record<string, unknown>;
const runChat = async (body: Record<string, unknown>): Promise<Ev[]> => {
  const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
      if (last?.type === "done" || last?.type === "error") return events;
    }
  }
  return events;
};

interface BenchCase {
  id: string;
  lang: "ar" | "en";
  agent: string;
  instructions?: string;
  workMode?: string;
  mode?: string;
  prompt: string;
  setup?: () => Promise<void>;
  verify: () => Promise<string>; // returns failure reason or "" on pass
}

const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

try {
  await start();
  const benchAgentRes = await post("/api/agents", { name: "المقيس", mode: "build" });
  const benchAgent = ((await benchAgentRes.json()) as { agent: { id: string } }).agent;
  const reviewerRes = await post("/api/agents", { name: "المدقق الإنجليزي", mode: "build", instructions: "أنت المدقق الإنجليزي" });
  const reviewer = ((await reviewerRes.json()) as { agent: { id: string } }).agent;
  const devRes = await post("/api/companion-devices", { agentId: benchAgent.id, template: "coding" });
  const devId = ((await devRes.json()) as { device: { id: string } }).device.id;
  {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const d = (await (await fetch(`${base}/api/companion-devices/${devId}`)).json()) as { device: { state: string } };
      if (d.device.state === "running") break;
      if (d.device.state === "error") throw new Error(JSON.stringify(d));
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  const results: Array<{ id: string; lang: string; pass: boolean; reason: string; ms: number; toolCalls: number }> = [];
  let lastTaskId = "";
  const runCase = async (c: BenchCase): Promise<void> => {
    await c.setup?.();
    const started = Date.now();
    const events = await runChat({ prompt: c.prompt, agentId: benchAgent.id, title: c.id, ...(c.workMode ? { workMode: c.workMode } : {}), ...(c.mode ? { mode: c.mode } : {}) });
    approvalsRaised += events.filter((e) => e.type === "approval_required").length;
    lastTaskId = String((events.find((e) => e.type === "task") as { taskId?: string } | undefined)?.taskId ?? lastTaskId);
    const toolCalls = events.filter((e) => e.type === "tool_call").length;
    const failure = events.some((e) => e.type === "error")
      ? `run error: ${JSON.stringify(events.find((e) => e.type === "error"))}`
      : await c.verify();
    results.push({ id: c.id, lang: c.lang, pass: failure === "", reason: failure || "ok", ms: Date.now() - started, toolCalls });
    (results.at(-1) as { taskDone?: boolean }).taskDone = events.some((e) => e.type === "done");
  };

  const wsOf = (taskId: string) => path.join(tmp, "ws", ".loam-tasks", taskId);

  const cases: BenchCase[] = [
    {
      id: "doc-ar", lang: "ar", agent: "المقيس", mode: "write", prompt: "BENCH-DOC-AR: أنشئ تقرير الربع كمستند",
      verify: async () => {
        const p = path.join(wsOf(lastTaskId), "bench-report-ar.md");
        if (!fs.existsSync(p)) return "document missing";
        return fs.readFileSync(p, "utf8").includes("12%") ? "" : "document content wrong";
      },
    },
    {
      id: "memory-ar", lang: "ar", agent: "المقيس", prompt: "BENCH-MEM-AR: احفظ تفضيلي في ذاكرتك",
      verify: async () => {
        const { entries } = (await (await fetch(`${base}/api/agents/${encodeURIComponent(benchAgent.id)}/memory`)).json()) as { entries: Array<{ text: string }> };
        return entries.some((e) => e.text.includes("الجداول قبل النص")) ? "" : "preference not saved";
      },
    },
    {
      id: "task-en", lang: "en", agent: "المقيس", prompt: "BENCH-TASK-EN: create the audit task",
      verify: async () => {
        const { tasks } = (await (await fetch(`${base}/api/tasks?agentId=${encodeURIComponent(benchAgent.id)}`)).json()) as { tasks: Array<{ title: string }> };
        return tasks.some((t) => (t.title ?? "").includes("Quarterly infrastructure audit")) ? "" : "task not created/owned";
      },
    },
    {
      id: "data-en", lang: "en", agent: "المقيس", mode: "data", prompt: "BENCH-DATA-EN: write the sales CSV then analyze it",
      verify: async () => {
        const csv = path.join(wsOf(lastTaskId), "bench.csv");
        if (!fs.existsSync(csv)) return "csv missing";
        const { task } = (await (await fetch(`${base}/api/tasks/${encodeURIComponent(lastTaskId)}`)).json()) as { task: { steps: Array<{ data?: { type?: string; name?: string; ok?: boolean; summary?: string } }> } };
        const ds = task.steps.find((s) => s.data?.type === "tool_result" && s.data?.name === "loam_dataset");
        return ds && ds.data?.ok === true ? "" : "dataset analysis missing/failed";
      },
    },
    {
      id: "device-ar", lang: "ar", agent: "المقيس", workMode: "own_device", prompt: "BENCH-DEVICE-AR: اعمل منفصلًا وسلّم الناتج",
      verify: async () => {
        const dir = path.join(wsOf(lastTaskId), "device-files");
        if (!fs.existsSync(dir)) return "no device delivery";
        const files = fs.readdirSync(dir);
        return files.length === 1 && fs.readFileSync(path.join(dir, files[0]!), "utf8").includes("داخل الجهاز المستقل") ? "" : "delivery content wrong";
      },
    },
    {
      id: "delegate-en", lang: "en", agent: "المقيس", prompt: "BENCH-DELEGATE-EN: delegate the sign-off to the reviewer",
      verify: async () => {
        const until = Date.now() + 30_000;
        for (;;) {
          const { tasks } = (await (await fetch(`${base}/api/tasks?agentId=${encodeURIComponent(reviewer.id)}`)).json()) as { tasks: Array<{ title: string; status: string }> };
          if (tasks.some((t) => (t.title ?? "").includes("Audit sign-off") && t.status === "done")) return "";
          if (Date.now() > until) return "delegate task not completed";
          await new Promise((r) => setTimeout(r, 200));
        }
      },
    },
  ];

  for (const c of cases) await runCase(c);

  const passed = results.filter((r) => r.pass).length;
  const summary = {
    suite: SUITE_VERSION,
    at: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    completionRate: Number((passed / results.length).toFixed(3)),
    userInterventions: approvalsRaised,
    wallMs: results.reduce((a, r) => a + r.ms, 0),
    toolCalls: results.reduce((a, r) => a + r.toolCalls, 0),
    byLanguage: {
      ar: { total: results.filter((r) => r.lang === "ar").length, passed: results.filter((r) => r.lang === "ar" && r.pass).length },
      en: { total: results.filter((r) => r.lang === "en").length, passed: results.filter((r) => r.lang === "en" && r.pass).length },
    },
    results,
  };
  const evidenceDir = path.resolve(import.meta.dirname, "../../docs/evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "companions-bench.json"), JSON.stringify(summary, null, 1));
  console.table(results.map((r) => ({ id: r.id, lang: r.lang, pass: r.pass, ms: r.ms, tools: r.toolCalls, reason: r.reason.slice(0, 160) })));
  console.log(`${SUITE_VERSION}: ${passed}/${results.length} pass | completion=${(summary.completionRate * 100).toFixed(0)}% | ar ${summary.byLanguage.ar.passed}/${summary.byLanguage.ar.total} en ${summary.byLanguage.en.passed}/${summary.byLanguage.en.total} | interventions=${approvalsRaised} | exported docs/evidence/companions-bench.json`);
  assert.equal(passed, results.length, `benchmark cases must all pass — regressions are quality regressions (see table)`);
} finally {
  await stop();
}
