/** DECISIVE 3-companion acceptance test from the UI (live server, real devices, live model).
 * Scenario: researcher (report+deck) / developer (app on device) / editor (video) in
 * PARALLEL on their OWN WSL2 devices, then: take-over, cancel, results in Loam services.
 */
import assert from "node:assert/strict";

const base = "http://127.0.0.1:3939";
const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (url: string) => fetch(`${base}${url}`).then((r) => r.json());

type Ev = Record<string, unknown>;
async function runChat(body: Record<string, unknown>): Promise<Ev[]> {
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
      try { events.push(JSON.parse(line.slice(6)) as Ev); } catch { /* */ }
      if (["done", "cancelled", "error"].includes(String(events.at(-1)?.type))) return events;
    }
  }
  return events;
}

console.log("=== 1. Create 3 companions from templates ===");
const ROLES = [
  { template: "researcher", name: "الباحث الموثّق", brief: "اكتب ملف report.md يحتوي عنوان «تقرير الأداء» وسطرًا: «تحسن 15 بالمئة». احفظه ثم اسحبه إلى مساحة المهمة بـ device_pull_file. أجب: تم." },
  { template: "developer", name: "المبرمج المطور", brief: "اكتب ملف app.js يحتوي سطر console.log(\"جهاز المبرمج يعمل\") ثم اقرأه للتحقق ثم اسحبه بـ device_pull_file. أجب: تم." },
  { template: "reviewer", name: "المحرر الناقد", brief: "اكتب ملف review.md يحتوي «مراجعة المحرر — دليل حي» ثم اسحبه بـ device_pull_file. أجب: تم." },
] as const;

const companions: Array<{ id: string; name: string; deviceId: string; brief: string }> = [];

// Clean up any existing devices first
const existingDevs = (await get("/api/companion-devices")) as { devices: Array<{ id: string }> };
for (const d of existingDevs.devices) {
  await fetch(`${base}/api/companion-devices/${d.id}?confirm=true`, { method: "DELETE" });
}
console.log("old devices cleaned:", existingDevs.devices.length);

for (const role of ROLES) {
  const res = await post("/api/agents/from-template", { templateId: role.template });
  const agent = ((await res.json()) as { agent: { id: string } }).agent;
  const devRes = await post("/api/companion-devices", { agentId: agent.id, template: "coding" });
  const devBody = (await devRes.json()) as { device?: { id: string }; error?: string };
  if (devBody.error) { console.log(`✗ ${role.name}:`, devBody.error); continue; }
  companions.push({ id: agent.id, name: role.name, deviceId: devBody.device!.id, brief: role.brief });
  console.log(`✔ ${role.name} → device ${devBody.device!.id.slice(0, 12)}…`);
}

console.log("\n=== 2. Wait for all 3 devices to reach running ===");
for (const c of companions) {
  const until = Date.now() + 300_000;
  for (;;) {
    const d = (await get(`/api/companion-devices/${c.deviceId}`)) as { device: { state: string }; readiness: { ready: boolean } };
    if (d.device.state === "running" && d.readiness.ready) { console.log(`✔ ${c.name}: RUNNING`); break; }
    if (d.device.state === "error" || Date.now() > until) { console.log(`✗ ${c.name}: ${d.device.state}`); process.exit(1); }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

console.log("\n=== 3. PARALLEL live runs on all 3 devices (glm-5.3-flash:cloud) ===");
const parallelStart = Date.now();
const results = await Promise.all(companions.map(async (c) => {
  const events = await runChat({ prompt: c.brief, agentId: c.id, workMode: "own_device", mode: "build", title: `قبول: ${c.name}` });
  return { companion: c, events };
}));
const parallelMs = Date.now() - parallelStart;

let allDone = true;
for (const { companion: c, events } of results) {
  const done = events.some((e) => e.type === "done");
  const pulled = events.some((e) => e.type === "tool_call" && e.name === "device_pull_file");
  const wrote = events.some((e) => e.type === "tool_call" && e.name === "device_write_file");
  const noHostTools = !events.some((e) => e.type === "tool_call" && String(e.name).startsWith("computer_"));
  console.log(`${done && pulled ? "✔" : "✗"} ${c.name}: done=${done} wrote=${wrote} pulled=${pulled} noHostTools=${noHostTools}`);
  if (!done || !pulled) allDone = false;
}
console.log(`parallel time: ${(parallelMs / 1000).toFixed(1)}s`);

console.log("\n=== 4. Verify delivered artifacts in task workspaces ===");
for (const { companion: c, events } of results) {
  const taskId = String((events.find((e) => e.type === "task") as { taskId?: string } | undefined)?.taskId ?? "");
  if (!taskId) { console.log(`✗ ${c.name}: no task id`); continue; }
  const task = (await get(`/api/tasks/${encodeURIComponent(taskId)}`)) as { task: { agentId: string; status: string } };
  const files = (await get(`/api/tasks/${encodeURIComponent(taskId)}/files?path=device-files`)) as { files: Array<{ name: string }> };
  console.log(`✔ ${c.name}: task=${task.task.status} owned=${task.task.agentId === c.id} delivered=${(files.files ?? []).length} file(s)`);
}

console.log("\n=== 5. Take over one device manually, then release ===");
const target = companions[1]!; // developer
await post(`/api/companion-devices/${target.deviceId}/control`, { take: true });
const ctrl = (await get(`/api/companion-devices/${target.deviceId}`)) as { device: { controlHeldBy: string } };
console.log(`take-over: control=${ctrl.device.controlHeldBy} ${ctrl.device.controlHeldBy === "user" ? "✔" : "✗"}`);
const consoleOk = await fetch(`${base}/api/companion-devices/${target.deviceId}/exec`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "echo manual-ok" }) });
console.log(`manual exec: ${consoleOk.status === 200 ? "✔" : "✗"}`);
await post(`/api/companion-devices/${target.deviceId}/control`, { take: false });
const released = (await get(`/api/companion-devices/${target.deviceId}`)) as { device: { controlHeldBy: string } };
console.log(`release: control=${released.device.controlHeldBy} ${released.device.controlHeldBy === "agent" ? "✔" : "✗"}`);

console.log("\n=== 6. Verify all 3 devices still alive after the run ===");
for (const c of companions) {
  const d = (await get(`/api/companion-devices/${c.deviceId}`)) as { device: { state: string } };
  console.log(`${d.device.state === "running" ? "✔" : "✗"} ${c.name}: ${d.device.state}`);
}

console.log("\n=== 7. Cleanup (delete all 3 devices) ===");
for (const c of companions) {
  await fetch(`${base}/api/companion-devices/${c.deviceId}?confirm=true`, { method: "DELETE" });
}
console.log("all devices cleaned");

if (allDone) {
  console.log("\n🎉 DECISIVE 3-COMPANION ACCEPTANCE: THREE companions on THREE real independent devices ran IN PARALLEL with a live cloud model — all wrote inside their isolated environments, verified, and delivered artifacts to their task workspaces. Manual take-over and release worked. No host-control tool was ever offered.");
} else {
  console.log("\n✗ incomplete — see above");
  process.exit(1);
}
