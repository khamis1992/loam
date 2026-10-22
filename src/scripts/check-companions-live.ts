/**
 * LIVE-model companion run (opt-in evidence, like check:swarm-live): a real
 * model drives the gateway — saves a preference into the companion's memory and
 * creates a real task through the tools. Requires a reachable Ollama.
 * Env: LOAM_COMPANIONS_MODEL (default: first available model).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-live-"));

const tagsRes = await fetch("http://127.0.0.1:11434/api/tags").catch(() => null);
if (!tagsRes?.ok) {
  console.log("SKIPPED: no reachable Ollama at 127.0.0.1:11434 (live evidence is opt-in).");
  process.exit(0);
}
const names = ((await tagsRes.json()) as { models: Array<{ name: string }> }).models.map((m) => m.name);
if (names.length === 0) {
  console.log("SKIPPED: Ollama reachable but no models installed.");
  process.exit(0);
}
const wanted = process.env.LOAM_COMPANIONS_MODEL;
const model = (wanted && names.includes(wanted)) || wanted ? wanted! : names.find((n) => !n.includes("embed")) ?? names[0]!;
console.log(`live model: ${model}`);

const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
const config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({
  model, fallbackModel: model, ollamaUrl: "http://127.0.0.1:11434",
  workspace: path.join(tmp, "workspace"), memory: { enabled: false }, screen: { enabled: false },
  selfImprove: { enabled: false }, orchestrator: { enabled: false }, mcpServers: {},
}));
fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });

let child: ChildProcess | undefined;
let logs = "";
const start = async (): Promise<void> => {
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: root, windowsHide: true,
    env: { ...process.env, MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: path.join(tmp, "data"), MANUS_LOCAL_PORT: String(port), MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills") },
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
  if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; }
};

try {
  await start();
  const agentRes = await fetch(`${base}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "رفيق الجولة الحية", mode: "build", instructions: "استخدم الأدوات عندما يُطلب منك ذلك صراحةً، ثم أجب بإيجاز." }) });
  const agent = ((await agentRes.json()) as { agent: { id: string } }).agent;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8 * 60_000);
  const res = await fetch(`${base}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
    body: JSON.stringify({
      prompt: "نفّذ حرفيًا: (1) احفظ في ذاكرتك الشخصية أنني أفضّل الإجابات بالعربية الفصحى. (2) أنشئ مهمة بعنوان «مهمة حية من الجولة الحية». (3) أجب بكلمة: تم",
      agentId: agent.id,
      title: "جولة حية",
    }),
  });
  assert.ok(res.ok && res.body, `chat http ${res.status}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Array<Record<string, unknown>> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, idx).split("\n").find((l) => l.startsWith("data: "));
      buf = buf.slice(idx + 2);
      if (!line) continue;
      try { events.push(JSON.parse(line.slice(6)) as Record<string, unknown>); } catch { /* skip */ }
      const last = events.at(-1);
      if (last?.type === "done" || last?.type === "error") { reader.cancel().catch(() => null); }
    }
  }
  clearTimeout(timer);
  assert.ok(events.some((e) => e.type === "done"), `live run must finish, tail=${JSON.stringify(events.slice(-3)).slice(0, 400)}`);

  const toolCalls = events.filter((e) => e.type === "tool_call").map((e) => String(e.name));
  console.log(`live tool calls: ${toolCalls.join(", ") || "(none)"}`);
  assert.ok(toolCalls.includes("companion_memory_save"), "the live model must save the preference via companion_memory_save");
  assert.ok(toolCalls.includes("task_create"), "the live model must create the task via task_create");

  const memory = (await (await fetch(`${base}/api/agents/${encodeURIComponent(agent.id)}/memory`)).json()) as { entries: Array<{ text: string }> };
  assert.ok(memory.entries.some((e) => e.text.includes("العربية الفصحى")), `memory must hold the user preference, got ${JSON.stringify(memory.entries.map((e) => e.text.slice(0, 40)))}`);
  const tasks = (await (await fetch(`${base}/api/tasks?agentId=${encodeURIComponent(agent.id)}`)).json()) as { tasks: Array<{ title: string; agentId: string }> };
  assert.ok(tasks.tasks.some((t) => (t.title ?? "").includes("مهمة حية")), `the live-created task must exist under its companion, saw ${JSON.stringify(tasks.tasks.map((t) => t.title))}`);
  console.log(`LIVE run green: model=${model} | memory preference saved + task created through the gateway by a real model, task owned by the companion.`);
} finally {
  await stop();
}
