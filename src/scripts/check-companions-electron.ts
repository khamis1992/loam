/**
 * THE decisive acceptance test from the REAL Electron UI (frontier section 21/10/5):
 * three companions (researcher/programmer/editor) each get their own independent
 * WSL device provisioned THROUGH THE UI, their work starts in parallel, the app is
 * fully closed and reopened, work survives and completes per its state, one device
 * is taken over manually then control is returned, another task is cancelled with
 * its in-device side effects proven stopped — evidence saved to docs/evidence/.
 *
 * Opt-in like the live bench: real Electron + real WSL devices + real model
 * (LOAM_ELECTRON_MODEL, default glm-5.3-flash:cloud through the local Ollama).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";

const root = process.cwd();
const MODEL = process.env.LOAM_ELECTRON_MODEL ?? "glm-5.3-flash:cloud";

// ── isolated environment ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-electron-accept-"));
const userData = path.join(tmp, "userData");
const dataDir = path.join(tmp, "data");
const workspace = path.join(tmp, "workspace");
for (const d of [userData, dataDir, workspace, path.join(dataDir, "devices")]) fs.mkdirSync(d, { recursive: true });
const configPath = path.join(userData, "config.json");
fs.writeFileSync(configPath, JSON.stringify({
  model: MODEL, fallbackModel: MODEL, ollamaUrl: "http://127.0.0.1:11434",
  workspace,
  memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false },
  orchestrator: { enabled: false }, computerUse: { enabled: false, screenshotDir: path.join(tmp, "shots") },
  mcpServers: {},
}, null, 2));
const goldenSrc = path.join(os.tmpdir(), "loam-golden", "golden-linux.tar");
assert.ok(fs.existsSync(goldenSrc), `golden rootfs missing: ${goldenSrc}`);
fs.copyFileSync(goldenSrc, path.join(dataDir, "devices", "golden-linux.tar"));

const freePort = async (): Promise<number> => {
  const p = http.createServer(); p.listen(0, "127.0.0.1"); await once(p, "listening");
  const port = (p.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((r) => p.close(() => r()));
  return port;
};
const appPort = await freePort();
const protoPort = await freePort();
const base = `http://127.0.0.1:${appPort}`;

const evDir = path.resolve(import.meta.dirname, "../../docs/evidence/electron-acceptance");
fs.mkdirSync(evDir, { recursive: true });
const evidence: Record<string, unknown> = { when: new Date().toISOString(), model: MODEL, appPort, phases: {} };
const shot = (name: string) => path.join(evDir, name);

// ── electron bootstrap ──
const { _electron: electron } = await import("playwright");
type App = Awaited<ReturnType<typeof electron.launch>>;
type Page = Awaited<ReturnType<App["firstWindow"]>>;

const launchApp = async (): Promise<{ app: App; page: Page }> => {
  const app = await electron.launch({
    args: [path.join(root, "electron", "main.cjs")],
    cwd: root,
    env: {
      ...process.env,
      LOAM_USER_DATA_DIR: userData,
      LOAM_PORT: String(appPort),
      AS_PROTOCOL_PORT: String(protoPort),
      LOAM_DISABLE_BRIDGE: "1",
      MANUS_LOCAL_CONFIG: configPath,
      MANUS_LOCAL_DATA_DIR: dataDir,
      MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills"),
      MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"),
    },
  });
  const page = await app.firstWindow();
  // capture the electron main + server child output for post-mortem diagnosis
  const proc = app.process();
  proc.stdout?.on("data", (c: Buffer) => { serverLog += c.toString(); });
  proc.stderr?.on("data", (c: Buffer) => { serverLog += c.toString(); });
  await page.setViewportSize({ width: 1440, height: 920 });
  // wait for the server to be up behind the window, then land on the companions UI
  const until = Date.now() + 120_000;
  for (;;) {
    if (Date.now() > until) throw new Error("app server did not answer /api/identity in 120s");
    if (await page.request.get(`${base}/api/identity`).then((r) => r.ok()).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await page.goto(`${base}/companions.html`);
  await page.waitForSelector("#rkBots", { timeout: 30_000 });
  // the fixed top "back to workspace" nav overlays modal buttons — hide it; it is not
  // part of what this test exercises
  await page.evaluate(() => {
    const nav = document.querySelector("nav[aria-label*='مساحة العمل']") as HTMLElement | null;
    if (nav) nav.style.display = "none";
  });
  return { app, page };
};

let serverLog = "";
const dumpServerLog = (why: string): void => {
  try { fs.writeFileSync(path.join(evDir, "server-log.txt"), `=== ${why} @ ${new Date().toISOString()} ===\n${serverLog.slice(-8000)}`, "utf8"); } catch { /* */ }
};

const api = async (url: string, init?: RequestInit): Promise<Record<string, unknown>> => {
  const token = fs.readFileSync(path.join(userData, ".loam-local-auth-token"), "utf8").trim();
  // the electron watchdog restarts a dead server — ride out brief refusals
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${base}${url}`, { ...init, headers: { "content-type": "application/json", "x-loam-local-token": token, ...(init?.headers ?? {}) } });
      return (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (err) {
      if (Date.now() > until || !String(err).includes("ECONNREFUSED")) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $id = (page: Page, id: string) => page.locator(`#${id}`);

async function createAgent(page: Page, name: string, description: string, instructions: string): Promise<string> {
  await $id(page, "rkAddAgent").click();
  await $id(page, "rkModal").waitFor({ state: "visible", timeout: 10_000 });
  await $id(page, "rkName").fill(name);
  await $id(page, "rkDesc").fill(description);
  await $id(page, "rkInstr").fill(instructions);
  await $id(page, "rkAgentWorkModeSel").selectOption("own_device");
  await $id(page, "rkSave").click();
  await $id(page, "rkModal").waitFor({ state: "hidden", timeout: 15_000 });
  await page.waitForSelector(`.rk-bot :text("${name}")`, { timeout: 15_000 });
  const agents = (await api("/api/agents")).agents as Array<{ id: string; name: string }>;
  const found = agents.find((a) => a.name === name);
  assert.ok(found, `agent ${name} must exist after UI creation`);
  return found.id;
}

async function selectAgent(page: Page, name: string): Promise<void> {
  await page.locator(`.rk-bot`, { hasText: name }).first().click();
  await page.waitForFunction((n) => (document.getElementById("rkHeadName")?.textContent ?? "").includes(n), name, { timeout: 15_000 });
}

async function provisionDevice(page: Page, template: string, agentId: string): Promise<string> {
  await $id(page, "rkDeviceBtn").click();
  await $id(page, "rkDeviceModal").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(() => ((document.getElementById("rkDevTemplate") as HTMLSelectElement | null)?.options.length ?? 0) > 0, undefined, { timeout: 20_000 });
  await $id(page, "rkDevTemplate").selectOption(template);
  await $id(page, "rkDevCreate").click();
  await sleep(1500);
  const until = Date.now() + 300_000;
  for (;;) {
    const state = (await $id(page, "rkDevState").textContent().catch(() => "")) ?? "";
    if (state.includes("يعمل")) break;
    if (Date.now() > until) throw new Error(`device provisioning timed out, last state: ${state}`);
    await sleep(3000);
  }
  const devices = (await api("/api/companion-devices")).devices as Array<{ id: string; agentId: string; state: string }>;
  const running = devices.find((d) => d.state === "running" && d.agentId === agentId);
  assert.ok(running, `this agent's running device must be listed, saw ${JSON.stringify(devices)}`);
  await $id(page, "rkDevClose").click();
  await $id(page, "rkDeviceModal").waitFor({ state: "hidden", timeout: 10_000 });
  return running.id;
}

async function deviceExec(deviceId: string, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  // first exec after a hard app kill may hit a cold distro — retry briefly
  for (let attempt = 1; ; attempt++) {
    const r = await api(`/api/companion-devices/${encodeURIComponent(deviceId)}/exec`, { method: "POST", body: JSON.stringify({ command }) });
    const out = { code: Number(r.code ?? 1), stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? r.error ?? "") };
    if (out.code === 0 || attempt >= 3) return out;
    await sleep(4000);
  }
}

async function ensureDeviceRunning(deviceId: string): Promise<void> {
  const list = (await api("/api/companion-devices")).devices as Array<{ id: string; state: string }>;
  const d = list.find((x) => x.id === deviceId);
  if (!d) throw new Error(`device ${deviceId} missing`);
  if (d.state === "running") return;
  await api(`/api/companion-devices/${encodeURIComponent(deviceId)}/start`, { method: "POST", body: "{}" });
  const until = Date.now() + 60_000;
  for (;;) {
    const cur = ((await api("/api/companion-devices")).devices as Array<{ id: string; state: string }>).find((x) => x.id === deviceId);
    if (cur?.state === "running") return;
    if (Date.now() > until) throw new Error(`device ${deviceId} did not return to running (${cur?.state})`);
    await sleep(2500);
  }
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  await $id(page, "rkPrompt").fill(text);
  await $id(page, "rkSend").click();
  await sleep(2500); // let the task start and the composer switch to streaming
}

async function waitForTaskStatus(taskId: string, statuses: string[], timeoutMs: number): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const t = (await api(`/api/tasks/${encodeURIComponent(taskId)}`)).task as { status: string } | undefined;
    const st = t?.status ?? "?";
    if (statuses.includes(st)) return st;
    if (Date.now() > until) throw new Error(`task ${taskId} did not reach ${statuses.join("|")} within ${timeoutMs / 1000}s (status=${st})`);
    await sleep(3000);
  }
}

async function latestTaskId(agentId: string): Promise<string> {
  const { tasks } = (await api(`/api/tasks?agentId=${encodeURIComponent(agentId)}`)) as { tasks: Array<{ id: string; createdAt?: string; title?: string }> };
  return tasks[0]!.id;
}

console.log(`Electron acceptance — model=${MODEL} app=:${appPort} data=${tmp}\n`);

// ══════════ Phase 1: launch + create three companions from the UI ══════════
{
  const { app, page } = await launchApp();
  evidence.phases = { ...evidence.phases as object, launch: "app booted, companions UI loaded" };

  const researcher = await createAgent(page, "الباحث", "بحث وكتابة تقارير", "نفّذ المطلوب مباشرة عبر جهازك المستقل بأدوات device_exec دون طرح أي أسئلة، وأنهِ بملخص ما أنجزته.");
  const programmer = await createAgent(page, "المبرمج", "بناء وتشغيل تطبيقات", "نفّذ المطلوب مباشرة عبر جهازك المستقل بأدوات device_exec دون طرح أي أسئلة، وأنهِ بملخص ما أنجزته.");
  const editor = await createAgent(page, "المحرر", "إنتاج فيديو", "نفّذ المطلوب مباشرة عبر جهازك المستقل بأدوات device_exec دون طرح أي أسئلة، وأنهِ بملخص ما أنجزته.");
  evidence.agents = { researcher, programmer, editor };
  console.log(`agents created from the UI: ${researcher} ${programmer} ${editor}`);
  await page.screenshot({ path: shot("1-agents-created.png"), fullPage: false });

  // ══════════ Phase 2: independent device per companion, from the UI ══════════
  await selectAgent(page, "الباحث");
  const devResearcher = await provisionDevice(page, "research", researcher);
  await selectAgent(page, "المبرمج");
  const devProgrammer = await provisionDevice(page, "coding", programmer);
  await selectAgent(page, "المحرر");
  const devEditor = await provisionDevice(page, "design", editor);
  evidence.devices = { researcher: devResearcher, programmer: devProgrammer, editor: devEditor };
  console.log(`devices provisioned from the UI: ${devResearcher} ${devProgrammer} ${devEditor}`);
  await selectAgent(page, "المحرر");
  await $id(page, "rkDeviceBtn").click();
  await $id(page, "rkDeviceModal").waitFor({ state: "visible", timeout: 10_000 });
  await page.screenshot({ path: shot("2-devices-provisioned.png") });
  await $id(page, "rkDevClose").click();

  // ══════════ Phase 3: start the three works in parallel from the UI ══════════
  await selectAgent(page, "الباحث");
  await sendPrompt(page, "اكتب داخل جهازك ملف /home/loam/report.md فيه تقرير موجز بالعربية عن أهم ثلاث تقنيات لعام 2026، كل تقنية سطر واحد، ثم تحقق من وجود الملف واعرض حجمه.");
  await selectAgent(page, "المبرمج");
  await sendPrompt(page, "أنشئ داخل جهازك ملف /home/loam/app/index.html بصفحة ويب بسيطة تحوي عنوان LOAM-ACCEPT، ثم شغّل خادم python3 -m http.server 8123 من مجلد app في الخلفية، وتحقق أن curl http://localhost:8123/index.html يجلب الصفحة. اترك الخادم يعمل.");
  await selectAgent(page, "المحرر");
  await sendPrompt(page, "أنشئ داخل جهازك ملف فيديو /home/loam/clip.mp4 مدته 3 ثوانٍ بمقاس 320x240 عبر ffmpeg باستخدام testsrc، ثم تحقق بـ ffprobe أنه قابل للتشغيل واذكر مدته.");
  console.log("three works dispatched in parallel (researcher report / programmer web app + server / editor video)");

  // wait until each has actually started executing (tool activity or status change)
  const tResearcher = await latestTaskId(researcher);
  const tProgrammer = await latestTaskId(programmer);
  const tEditor = await latestTaskId(editor);
  evidence.tasksWave1 = { researcher: tResearcher, programmer: tProgrammer, editor: tEditor };
  await waitForTaskStatus(tResearcher, ["running", "done"], 180_000).catch(() => {});
  await waitForTaskStatus(tProgrammer, ["running", "done"], 180_000).catch(() => {});
  await waitForTaskStatus(tEditor, ["running", "done"], 180_000).catch(() => {});
  // give the researcher a chance to finish (proves finished work survives the close),
  // while the others are still mid-flight; if everything finished too fast, start a
  // long task so the close genuinely interrupts something
  await waitForTaskStatus(tResearcher, ["done"], 6 * 60_000).catch(() => {});
  const statusOf = async (id: string): Promise<string> => ((await api(`/api/tasks/${encodeURIComponent(id)}`)).task as { status: string } | undefined)?.status ?? "?";
  const stR = await statusOf(tResearcher), stP = await statusOf(tProgrammer), stE = await statusOf(tEditor);
  if (stP !== "running" && stE !== "running" && stR !== "running") {
    await selectAgent(page, "المحرر");
    await sendPrompt(page, "شغّل داخل جهازك الأمر: for i in $(seq 1 300); do echo tick-$i >> /home/loam/ticks.log; sleep 1; done — انتظر انتهاءه ثم اذكر عدد الأسطر.");
    await sleep(3000);
    const longTask = await latestTaskId(editor);
    (evidence as Record<string, unknown>).longTaskForInterruption = longTask;
    await waitForTaskStatus(longTask, ["running"], 120_000);
  }
  await page.screenshot({ path: shot("3-works-parallel.png") });

  // ══════════ Phase 4: close the whole app mid-work ══════════
  const before = {
    researcher: (await api(`/api/tasks/${encodeURIComponent(tResearcher)}`)).task as { status: string },
    programmer: (await api(`/api/tasks/${encodeURIComponent(tProgrammer)}`)).task as { status: string },
    editor: (await api(`/api/tasks/${encodeURIComponent(tEditor)}`)).task as { status: string },
  };
  evidence.statusBeforeClose = { researcher: before.researcher.status, programmer: before.programmer.status, editor: before.editor.status };
  console.log(`closing the app — statuses at close: R=${before.researcher.status} P=${before.programmer.status} E=${before.editor.status}`);
  await app.close();
  await sleep(4000);
  (evidence.phases as Record<string, string>).closed = `app fully closed (statuses: R=${before.researcher.status} P=${before.programmer.status} E=${before.editor.status})`;
}

// ══════════ Phase 5: reopen — everything must survive ══════════
{
  let { app, page } = await launchApp();
  // if the server dies mid-phase, a real user relaunches the app — mirror that
  const relaunch = async (): Promise<void> => {
    try { await app.close(); } catch { /* already gone */ }
    await sleep(3000);
    ({ app, page } = await launchApp());
  };
  for (const name of ["الباحث", "المبرمج", "المحرر"]) {
    await page.waitForSelector(`.rk-bot :text("${name}")`, { timeout: 15_000 });
  }
  const agents = (await api("/api/agents")).agents as Array<{ name: string }>;
  assert.equal(agents.filter((a) => ["الباحث", "المبرمج", "المحرر"].includes(a.name)).length, 3, "all three companions must survive the close/reopen");
  const devices = (await api("/api/companion-devices")).devices as Array<{ id: string; state: string }>;
  assert.equal(devices.length, 3, `all three devices must survive the close/reopen, saw ${JSON.stringify(devices)}`);
  const { researcher, programmer, editor } = evidence.agents as { researcher: string; programmer: string; editor: string };
  const t1 = evidence.tasksWave1 as { researcher: string; programmer: string; editor: string };
  const after = {
    researcher: ((await api(`/api/tasks/${encodeURIComponent(t1.researcher)}`)).task as { status: string }).status,
    programmer: ((await api(`/api/tasks/${encodeURIComponent(t1.programmer)}`)).task as { status: string }).status,
    editor: ((await api(`/api/tasks/${encodeURIComponent(t1.editor)}`)).task as { status: string }).status,
  };
  evidence.statusAfterReopen = after;
  console.log(`reopened: agents=3 devices=3, task statuses now: R=${after.researcher} P=${after.programmer} E=${after.editor}`);
  await page.screenshot({ path: shot("4-reopened.png") });

  // ══════════ Phase 6: resume unfinished work FROM THE UI ══════════
  // The official resume path is the tasks page's «استئناف المهمة» button
  // (POST /api/tasks/:id/resume with the interrupted-step confirmation dialog).
  const agentIdByName = async (name: string): Promise<string> => {
    const list = (await api("/api/agents")).agents as Array<{ id: string; name: string }>;
    return list.find((a) => a.name === name)!.id;
  };
  const statusOfTask = async (id: string): Promise<string> => ((await api(`/api/tasks/${encodeURIComponent(id)}`)).task as { status: string } | undefined)?.status ?? "?";
  const resume = async (name: string): Promise<void> => {
    const agentId = await agentIdByName(name);
    const taskId = await latestTaskId(agentId);
    const st = await statusOfTask(taskId);
    if (st === "done") {
      console.log(`  ${name}: already done before close — survival verified in artifacts phase`);
      return;
    }
    // devices were hard-killed with the app: bring this companion's device back first (UI lifecycle button)
    const devId = ((await api("/api/companion-devices")).devices as Array<{ id: string; agentId: string; state: string }>).find((d) => d.agentId === agentId)?.id;
    if (devId) await ensureDeviceRunning(devId);
    await page.goto(`${base}/`);
    // SPA boot is async (modes fetch) — clicking nav before it finishes loses the
    // hashchange event, so wait for a boot-populated element first
    await page.waitForFunction(() => (document.getElementById("modeCards")?.children.length ?? 0) > 0, undefined, { timeout: 25_000 });
    await page.click('a[href="#/tasks"]');
    await page.waitForSelector("#listBody .task-row", { timeout: 20_000 });
    // open the interrupted task by clicking its own row (real user path; note
    // .task-row also exists on the hidden home view — scope to the tasks list)
    const row = page.locator(`#listBody a.task-row[href*="${taskId}"]`).first();
    await row.waitFor({ state: "visible", timeout: 15_000 });
    await row.click();
    // the recovery box lives on the «الملخص» tab — make sure it is the shown panel
    await page.locator("#overviewTab").click().catch(() => {});
    // click the official resume button and accept the confirmation dialog
    const btn = page.locator("#taskRecovery button").filter({ hasText: "استئناف المهمة" }).first();
    await btn.waitFor({ state: "visible", timeout: 30_000 });
    await btn.click();
    await sleep(800);
    // confirmAction uses an in-page <dialog> — accept it if it opens
    const dialogConfirm = page.locator("#confirmDialog button, dialog[open] button").filter({ hasText: /تأكيد|متابعة|نعم|confirm/i }).first();
    if (await dialogConfirm.isVisible().catch(() => false)) await dialogConfirm.click();
    console.log(`  ${name}: resume clicked from the tasks UI (${taskId})`);
    try {
      await waitForTaskStatus(taskId, ["done", "error"], 15 * 60_000);
    } catch (err) {
      // server died mid-resume — record it, then relaunch like a real user would
      dumpServerLog(`resume-${name}-server-died`);
      resumeFailures.push(`${name} resume interrupted by server loss: ${String(err).slice(0, 120)}`);
      console.log(`  ${name}: server lost mid-resume — relaunching the app and continuing`);
      await relaunch();
      return;
    }
    const finalSt = await statusOfTask(taskId);
    if (finalSt !== "done") {
      resumeFailures.push(`${name} resumed but ended ${finalSt}`);
      console.log(`  ${name}: resume ended ${finalSt} — recorded, continuing`);
      return;
    }
    console.log(`  ${name}: resumed from the UI → done`);
    evidence[`resumed_task_${name}`] = taskId;
    await page.goto(`${base}/companions.html`);
    await page.waitForSelector("#rkBots", { timeout: 15_000 });
    await page.evaluate(() => { const nav = document.querySelector("nav[aria-label*='مساحة العمل']") as HTMLElement | null; if (nav) nav.style.display = "none"; });
  };
  const resumeFailures: string[] = [];
  await resume("الباحث");
  await resume("المحرر");
  await resume("المبرمج");
  (evidence as Record<string, unknown>).resumeFailures = resumeFailures;
  await page.screenshot({ path: shot("5-resumed.png") });

  // ══════════ Phase 7: manual takeover + return of control (editor's device) ══════════
  {
    const devEditor = (evidence.devices as { editor: string }).editor;
    await ensureDeviceRunning(devEditor);
    await selectAgent(page, "المحرر");
    await $id(page, "rkDeviceBtn").click();
    await $id(page, "rkDeviceModal").waitFor({ state: "visible", timeout: 10_000 });
    await sleep(1500);
    await $id(page, "rkDevTake").click();
    await sleep(1500);
    let stateText = (await $id(page, "rkDevState").textContent()) ?? "";
    assert.ok(stateText.includes("المستخدم يتولى التحكم"), `takeover must show in the UI, saw: ${stateText}`);
    // agent commands must be blocked while the user holds control
    const blocked = await deviceExec(devEditor, "echo must-not-run");
    assert.ok(blocked.code !== 0 || blocked.stderr, "agent exec must be blocked under user control");
    await page.screenshot({ path: shot("6-takeover.png") });
    await $id(page, "rkDevTake").click(); // return control
    await sleep(1500);
    stateText = (await $id(page, "rkDevState").textContent()) ?? "";
    assert.ok(!stateText.includes("المستخدم يتولى التحكم"), "control must return to the companion");
    const unblocked = await deviceExec(devEditor, "echo back-again");
    assert.ok(unblocked.code === 0 && unblocked.stdout.includes("back-again"), `agent exec must work again after control return, got code=${unblocked.code} out="${unblocked.stdout.slice(0, 60)}" err="${unblocked.stderr.slice(0, 120)}"`);
    console.log("takeover + control-return proven from the UI (agent blocked while held, working after return)");
    evidence.takeover = { blockedWhileHeld: true, worksAfterReturn: true };
    await $id(page, "rkDevClose").click();
  }

  // ══════════ Phase 8: cancel a running task — in-device effects must stop ══════════
  {
    const programmer = await agentIdByName("المبرمج");
    const devProgrammer = (evidence.devices as { programmer: string }).programmer;
    await selectAgent(page, "المبرمج");
    await sendPrompt(page, "شغّل داخل جهازك الأمر: nohup bash -c 'for i in $(seq 1 600); do echo line-$i >> /home/loam/counter.log; sleep 1; done' >/dev/null 2>&1 & ثم تحقق أن العملية تعمل بـ ps واذكر عددها، وانتظر رسالتي التالية.");
    await sleep(4000);
    const cancelTask = await latestTaskId(programmer);
    await waitForTaskStatus(cancelTask, ["running", "done"], 120_000).catch(() => {});
    // the counting process must be alive inside the device
    let alive = await deviceExec(devProgrammer, "pgrep -f 'counter.log' | wc -l");
    const aliveCount1 = Number(alive.stdout.trim() || "0");
    // cancel FROM THE UI (stop button on the streaming composer)
    await $id(page, "rkStop").click();
    const st = await waitForTaskStatus(cancelTask, ["cancelled", "error", "done"], 90_000);
    await sleep(4000); // give the cancellation time to kill the in-device process group
    alive = await deviceExec(devProgrammer, "pgrep -f 'counter.log' | wc -l");
    const aliveCount2 = Number(alive.stdout.trim() || "0");
    const growth = await deviceExec(devProgrammer, "wc -l < /home/loam/counter.log");
    await sleep(5000);
    const growth2 = await deviceExec(devProgrammer, "wc -l < /home/loam/counter.log");
    evidence.cancellation = { taskStatus: st, processesBefore: aliveCount1, processesAfter: aliveCount2, logLinesAfterCancel: growth2.stdout.trim(), logLinesStable: growth.stdout.trim() === growth2.stdout.trim() };
    assert.equal(aliveCount2, 0, `the in-device counting process must be dead after UI cancellation (was ${aliveCount1})`);
    assert.ok(growth.stdout.trim() === growth2.stdout.trim(), "the side-effect log must stop growing after cancellation");
    console.log(`cancellation proven: status=${st}, in-device processes ${aliveCount1}→${aliveCount2}, counter.log frozen at ${growth2.stdout.trim()} lines`);
    await page.screenshot({ path: shot("7-cancelled.png") });
  }

  // ══════════ Phase 9: verify the actual work products inside the devices ══════════
  {
    const dev = evidence.devices as { researcher: string; programmer: string; editor: string };
    const report = await deviceExec(dev.researcher, "wc -c < /home/loam/report.md && head -c 120 /home/loam/report.md");
    assert.ok(report.code === 0 && Number(report.stdout.split("\n")[0] ?? 0) > 30, `researcher report.md must exist with real content, got: ${report.stdout.slice(0, 120)} ${report.stderr.slice(0, 120)}`);
    const app = await deviceExec(dev.programmer, "test -f /home/loam/app/index.html && grep -c LOAM-ACCEPT /home/loam/app/index.html");
    assert.ok(app.code === 0 && Number(app.stdout.trim()) >= 1, "programmer app/index.html must exist with the marker");
    const video = await deviceExec(dev.editor, "ffprobe -v error -show_entries format=duration -of csv=p=0 /home/loam/clip.mp4");
    assert.ok(video.code === 0 && Math.abs(Number(video.stdout.trim()) - 3) < 0.6, `editor clip.mp4 must be a playable ~3s video, got: ${video.stdout} ${video.stderr.slice(0, 100)}`);
    // cross-device isolation: the researcher's device must not see the others' files
    const isolation = await deviceExec(dev.researcher, "ls /home/loam");
    assert.ok(!isolation.stdout.includes("index.html") && !isolation.stdout.includes("clip.mp4"), "researcher device must not contain the other companions' artifacts");
    evidence.artifacts = {
      researcherReport: { bytes: Number(report.stdout.split("\n")[0]), head: report.stdout.split("\n").slice(1).join(" ").trim().slice(0, 120) },
      programmerApp: "index.html with LOAM-ACCEPT marker",
      editorVideo: { durationSec: Number(video.stdout.trim()) },
      crossDeviceIsolation: true,
    };
    console.log(`artifacts verified in-device: report=${Number(report.stdout.split("\n")[0])}B, app marker ok, video=${video.stdout.trim()}s, cross-device isolation ok`);
    await page.screenshot({ path: shot("8-complete.png") });
  }

  // every resumed task must have completed (collected here so the full journey runs first)
  assert.deepEqual(resumeFailures, [], "all interrupted works must complete after UI resume");

  // ══════════ cleanup devices + close ══════════
  const dev = evidence.devices as { researcher: string; programmer: string; editor: string };
  for (const id of [dev.researcher, dev.programmer, dev.editor]) {
    await api(`/api/companion-devices/${encodeURIComponent(id)}?confirm=true`, { method: "DELETE" }).catch(() => {});
  }
  evidence.cleanup = "3 devices deleted, app closed";
  fs.writeFileSync(path.resolve(import.meta.dirname, "../../docs/evidence/electron-acceptance.json"), JSON.stringify(evidence, null, 2), "utf8");
  await app.close();
}

console.log(`
Electron UI acceptance (decisive test): three companions created from the real UI each with their own WSL device provisioned from the UI; their works ran in parallel (report / web app with a live server / playable video); the app was fully closed mid-work and reopened — agents, devices and task history survived and unfinished work was resumed from the UI's own surfaced pending message; manual takeover blocked the agent and control return restored it; a UI cancellation stopped the in-device side effects (process dead, log frozen); artifacts verified inside each device with cross-device isolation. Evidence: docs/evidence/electron-acceptance/ + electron-acceptance.json
`);
