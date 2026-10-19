/**
 * Acceptance scenario (قسم 24 / سيناريو القبول الأساسي): THREE companions, each
 * on its OWN isolated device, deliver verified artifacts while the user's machine
 * stays untouched (no computer_* tools ever reach their runs). Deterministic:
 * fake device runner + stub model, real src/index.ts process.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-acceptance-"));

/* stub model: each own-device run performs a real deliverable flow inside its
   device (write the artifact → pull it into the task workspace → report). */
const seen: Array<{ agent: string; tools: string[]; system: string }> = [];
const inFlight = new Set<string>();
let overlapWitnessed = false;
const model = http.createServer(async (req, res) => {
  if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "test-model" }] })); return; }
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const messages = body.messages as Array<{ role: string; content: string }>;
  const system = messages[0]?.content ?? "";
  const agent = /أنت "([^"]+)"/.exec(system)?.[1] ?? "unknown";
  seen.push({ agent, tools: (body.tools ?? []).map((t: { function?: { name?: string } }) => t.function?.name ?? "").filter(Boolean), system });
  inFlight.add(agent);
  if (inFlight.size >= 2) overlapWitnessed = true;
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
  const toolCount = messages.filter((m) => m.role === "tool").length;
  let payload: { role: string; content: string; tool_calls?: unknown[] };
  if (toolCount === 0) {
    payload = { role: "assistant", content: "", tool_calls: [{ function: { name: "device_write_file", arguments: { path: "/home/loam/deliverable.md", content: `تسليم ${agent} — ناتج مُتحقق من سيناريو القبول` } } }] };
  } else if (toolCount === 1) {
    payload = { role: "assistant", content: "", tool_calls: [{ function: { name: "device_pull_file", arguments: { path: "/home/loam/deliverable.md" } } }] };
  } else {
    payload = { role: "assistant", content: `سُلِّم عمل «${agent}» ونُسخ إلى مساحة المهمة.` };
  }
  // Hold each model call briefly so concurrent runs provably overlap in time.
  await new Promise((r) => setTimeout(r, 900));
  inFlight.delete(agent);
  res.setHeader("content-type", "application/x-ndjson");
  res.end(JSON.stringify({ model: "test-model", message: payload, done: true }) + "\n");
});
model.listen(0, "127.0.0.1"); await once(model, "listening");
const modelPort = (model.address() as import("node:net").AddressInfo).port;

const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
const config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({
  model: "test-model", fallbackModel: "test-model", ollamaUrl: `http://127.0.0.1:${modelPort}`,
  workspace: path.join(tmp, "workspace"), computerUse: { enabled: false, screenshotDir: path.join(tmp, "shots") },
  memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false },
  orchestrator: { enabled: false }, mcpServers: {},
}));
fs.mkdirSync(path.join(tmp, "workspace"), { recursive: true });

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
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`startup timeout\n${logs.slice(-2000)}`);
};
const stop = async (): Promise<void> => {
  if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; }
  await new Promise<void>((resolve) => model.close(() => resolve()));
};

type Ev = Record<string, unknown>;
const runChat = async (body: Record<string, unknown>): Promise<Ev[]> => {
  const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.ok(res.ok && res.body, `chat ${res.status}`);
  const events: Ev[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, idx).split("\n").find((l) => l.startsWith("data: "));
      buf = buf.slice(idx + 2);
      if (!line) continue;
      try { events.push(JSON.parse(line.slice(6)) as Ev); } catch { /* skip */ }
      const last = events.at(-1);
      if (last?.type === "done" || last?.type === "error") return events;
    }
  }
  return events;
};
const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const SCENARIO: Array<{ name: string; template: string; brief: string }> = [
  { name: "معد التقارير", template: "office", brief: "أعد تقرير الربع وعرضه التقديمي على جهازك المستقل وسلّمه" },
  { name: "مطور التطبيقات", template: "coding", brief: "طوّر تطبيق قائمة المهام على جهازك المستقل وسلّم الكود" },
  { name: "منتج الفيديو", template: "design", brief: "أنتج فيديو تعريفيًا قصيرًا على جهازك المستقل وسلّم المخرج" },
];

try {
  await start();
  for (const role of SCENARIO) {
    // provision this companion's own device and wait until ready
    const agentRes = await post("/api/agents", { name: role.name, mode: "build", instructions: `أنت "${role.name}"` });
    const agent = ((await agentRes.json()) as { agent: { id: string; name: string } }).agent;
    const devRes = await post("/api/companion-devices", { agentId: agent.id, template: role.template });
    const devBody = (await devRes.json()) as { device: { id: string } };
    assert.equal(devRes.status, 202, JSON.stringify(devBody));
    const devId = devBody.device.id;
    const until = Date.now() + 30_000;
    for (;;) {
      const d = (await (await fetch(`${base}/api/companion-devices/${devId}`)).json()) as { device: { state: string } };
      if (d.device.state === "running") break;
      if (d.device.state === "error" || Date.now() > until) throw new Error(`device for ${role.name}: ${JSON.stringify(d)}`);
      await new Promise((r) => setTimeout(r, 80));
    }

    // the user asks this companion to work separately — it executes on ITS device
    const events = await runChat({ prompt: role.brief, agentId: agent.id, workMode: "own_device" });
    assert.ok(events.some((e) => e.type === "done"), `${role.name}: run must finish, tail=${JSON.stringify(events.slice(-2))}`);
    const wm = events.find((e) => e.type === "workmode") as { deviceId?: string } | undefined;
    assert.equal(wm?.deviceId, devId, `${role.name}: run must execute on its own device`);
    assert.ok(events.some((e) => e.type === "tool_call" && e.name === "device_write_file"), `${role.name}: must author inside its device`);
    assert.ok(events.some((e) => e.type === "tool_call" && e.name === "device_pull_file"), `${role.name}: must pull the deliverable out`);
    assert.ok(events.some((e) => e.type === "tool_result" && e.name === "device_pull_file" && e.ok === true), `${role.name}: the pull must succeed`);

    // verified delivery: the artifact exists in the task workspace with this companion's mark
    const taskId = (events.find((e) => e.type === "task") as { taskId?: string } | undefined)?.taskId;
    assert.ok(taskId, `${role.name}: task id required`);
    const task = ((await (await fetch(`${base}/api/tasks/${encodeURIComponent(taskId!)}`)).json()) as { task: { agentId: string; status: string; steps: unknown[] } }).task;
    assert.equal(task.agentId, agent.id);
    assert.equal(task.status, "done");
    const ws = path.join(tmp, "workspace", ".loam-tasks", taskId!, "device-files");
    const delivered = fs.readdirSync(ws);
    assert.equal(delivered.length, 1, `${role.name}: exactly one delivered artifact`);
    const content = fs.readFileSync(path.join(ws, delivered[0]!), "utf8");
    assert.ok(content.includes(role.name) && content.includes("ناتج مُتحقق"), `${role.name}: delivered artifact must carry its producer's mark, got: ${content.slice(0, 80)}`);

    // the user's machine stays untouched: no host-control tool ever reached this run
    const ownRuns = seen.filter((s) => s.agent === role.name);
    assert.ok(ownRuns.length >= 3, `${role.name}: model must have been called`);
    assert.ok(ownRuns.every((s) => !s.tools.some((t) => t.startsWith("computer_") || t.startsWith("screen_"))), `${role.name}: host control tools must never appear on its own-device run`);
    // and the viewer/api surface stayed alive for the user throughout
    const devicesList = (await (await fetch(`${base}/api/companion-devices`)).json()) as { devices: unknown[] };
    assert.ok(Array.isArray(devicesList.devices));
    console.log(`✔ ${role.name}: جهاز خاص → تنفيذ داخله → تسليم مُتحقق («${delivered[0]}») دون أي أداة تلمس جهاز المستخدم`);
  }
  // ── Section 24: TWO companions on TWO independent devices AT THE SAME TIME ──
  overlapWitnessed = false;
  const parRoles = [
    { name: "الكاتب المتوازي أ", template: "coding" as const },
    { name: "الكاتب المتوازي ب", template: "research" as const },
  ];
  const parStarted = Date.now();
  const parRuns = parRoles.map(async (role) => {
    const agentRes = await post("/api/agents", { name: role.name, mode: "build", instructions: `أنت "${role.name}"` });
    const agent = ((await agentRes.json()) as { agent: { id: string; name: string } }).agent;
    const devRes = await post("/api/companion-devices", { agentId: agent.id, template: role.template });
    const devBody = (await devRes.json()) as { device: { id: string } };
    assert.equal(devRes.status, 202, JSON.stringify(devBody));
    const untilP = Date.now() + 30_000;
    for (;;) {
      const d = (await (await fetch(`${base}/api/companion-devices/${devBody.device.id}`)).json()) as { device: { state: string } };
      if (d.device.state === "running") break;
      if (d.device.state === "error" || Date.now() > untilP) throw new Error(`device for ${role.name}: ${JSON.stringify(d)}`);
      await new Promise((r) => setTimeout(r, 80));
    }
    const events = await runChat({ prompt: "اعمل منفصلًا وسلّم ناتجك", agentId: agent.id, workMode: "own_device" });
    return { role, agent, events, deviceId: devBody.device.id };
  });
  const parResults = await Promise.all(parRuns);
  const parElapsed = Date.now() - parStarted;
  for (const { role, events, deviceId } of parResults) {
    assert.ok(events.some((e) => e.type === "done"), `${role.name}: parallel run must finish`);
    const wm = events.find((e) => e.type === "workmode") as { deviceId?: string } | undefined;
    assert.equal(wm?.deviceId, deviceId, `${role.name}: must run on its own device`);
    assert.ok(events.some((e) => e.type === "tool_call" && e.name === "device_pull_file"), `${role.name}: must deliver`);
  }
  assert.ok(overlapWitnessed, "the two companions' runs must overlap in time (true parallelism, section 24)");
  assert.ok(parElapsed < 20_000, "parallel phase must not run serially-doubled");
  console.log(`✔ توازٍ حقيقي: مساعدان على جهازين مستقلين عملا في الوقت نفسه (تداخل مؤكد داخل نموذج الستُب) في ${(parElapsed / 1000).toFixed(1)}ث`);

  console.log("Acceptance scenario: ثلاثة مساعدين على ثلاثة أجهزة مستقلة سلّموا نتائج مُتحققًا منها، ثم مساعدان على جهازين بالتوازي الحقيقي المؤكد — وجهاز المستخدم بلا أي أداة تحكم في كل ذلك.");
} finally {
  await stop();
}
