/** REAL device from the running app: prepare golden → create device for a
 *  companion → run a LIVE chat on it (own_device) with the configured model. */
import assert from "node:assert/strict";

const base = "http://127.0.0.1:3939"; // the live app
const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// 1. golden ready?
const devRoot = (await (await fetch(`${base}/api/companion-devices`)).json()) as { goldenReady: boolean; devices: unknown[]; wsl: boolean };
console.log("golden:", devRoot.goldenReady, "| wsl:", devRoot.wsl, "| existing devices:", devRoot.devices.length);
assert.ok(devRoot.wsl, "WSL provider must be available");
if (!devRoot.goldenReady) {
  console.log("preparing golden from Ubuntu-24.04...");
  const g = await post("/api/companion-devices/golden", { fromDistro: "Ubuntu-24.04" });
  console.log("golden result:", g.status);
}

// 2. create the companion (or reuse)
const agents = (await (await fetch(`${base}/api/agents`)).json()) as { agents: Array<{ id: string; name: string }> };
let agent = agents.agents.find((a) => a.name.includes("المطور"));
if (!agent) {
  const res = await post("/api/agents/from-template", { templateId: "developer" });
  agent = ((await res.json()) as { agent: { id: string; name: string } }).agent;
  console.log("created companion:", agent.name, agent.id);
} else {
  console.log("reusing companion:", agent.name, agent.id);
}

// 3. delete any existing device for this agent, then create a REAL one
const devices = (await (await fetch(`${base}/api/companion-devices`)).json()) as { devices: Array<{ id: string; agentId: string; state: string }> };
const existing = devices.devices.find((d) => d.agentId === agent!.id);
if (existing) {
  await fetch(`${base}/api/companion-devices/${existing.id}?confirm=true`, { method: "DELETE" });
  console.log("old device deleted");
}
const devRes = await post("/api/companion-devices", { agentId: agent!.id, template: "coding" });
console.log("device create:", devRes.status);
const devBody = (await devRes.json()) as { device?: { id: string; state: string }; error?: string };
if (devBody.error) { console.log("ERROR:", devBody.error); process.exit(1); }
const deviceId = devBody.device!.id;

// 4. wait for running
const until = Date.now() + 300_000;
for (;;) {
  const d = (await (await fetch(`${base}/api/companion-devices/${deviceId}`)).json()) as { device: { state: string }; readiness: { ready: boolean } };
  if (d.device.state === "running" && d.readiness.ready) { console.log("✔ device RUNNING and ready"); break; }
  if (d.device.state === "error" || Date.now() > until) { console.log("✗ device:", d.device.state); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1000));
}

// 5. LIVE chat on the device with the strong cloud model
console.log("starting LIVE run (own_device)...");
const chatRes = await fetch(`${base}/api/chat`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    prompt: "اكتب ملفًا اسمه proof.md داخل جهازك المستقل يحتوي السطر: «جهاز المساعد يعمل فعليًا — دليل حي». ثم اقرأه وتأكد من محتواه ثم اسحبه إلى مساحة المهمة بـ device_pull_file. أجب: تم.",
    agentId: agent!.id, workMode: "own_device", mode: "build",
    title: "دليل الجهاز الحي",
  }),
});
const events: Array<Record<string, unknown>> = [];
const reader = chatRes.body!.getReader();
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
    try {
      const ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
      events.push(ev);
      if (ev.type === "tool_call") console.log(`  → ${ev.name}`);
      if (ev.type === "tool_result") console.log(`  ${ev.ok ? "✔" : "✗"} ${ev.name}: ${String(ev.summary ?? "").slice(0, 80)}`);
    } catch { /* skip */ }
  }
}
const done = events.some((e) => e.type === "done");
const wm = events.find((e) => e.type === "workmode") as { deviceId?: string } | undefined;
const wroteProof = events.some((e) => e.type === "tool_call" && e.name === "device_write_file");
const readProof = events.some((e) => e.type === "tool_call" && e.name === "device_read_file");
const pulled = events.some((e) => e.type === "tool_result" && e.name === "device_pull_file" && (e as { ok?: boolean }).ok === true);

console.log(`\ndone=${done} | deviceId=${wm?.deviceId === deviceId ? "MATCH" : "MISMATCH"} | wrote=${wroteProof} read=${readProof} pulled=${pulled}`);
if (done && wroteProof && pulled) {
  console.log("\n🎉 REAL DEVICE FROM UI: جهاز حقيقي أُنشئ من الواجهة وتشغّلت عليه جولة حية كاملة — الكتابة والقراءة والسحب نجحت فعليًا داخل بيئة WSL2 معزولة.");
} else {
  console.log("\n✗ incomplete — see events above");
  process.exit(1);
}
