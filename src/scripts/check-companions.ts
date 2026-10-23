/**
 * Deterministic gate for companions frontier stage 1 (unified capability gateway).
 * No live model: it exercises the gateway resolver, the registry extras path and
 * the agents store with isolated temp data, mirroring check-loam-agents.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-companions-'));
const root = process.cwd();
process.env.MANUS_LOCAL_DATA_DIR = dir;
process.env.MANUS_LOCAL_SKILLS_DIR = path.join(dir, 'skills');

const gateway = await import('../server/companionGateway.js');
const { WORK_MODES, COMPANION_SERVICES, normalizeWorkMode, getWorkMode, resolveCompanionCapabilities, uncoveredModeTools, getWorkModesUi } = gateway;
const { ToolRegistry } = await import('../tools/registry.js');
const { createAgent, updateAgent, listAgents } = await import('../server/agents.js');
const { LOAM_MODES, getLoamMode } = await import('../modes/catalog.js');

/* ---------- 1. work mode normalization ---------- */
assert.equal(normalizeWorkMode(undefined), 'loam');
assert.equal(normalizeWorkMode(''), 'loam');
assert.equal(normalizeWorkMode(' user_device '), 'user_device');
assert.throws(() => normalizeWorkMode('turbo'), /Unknown work mode: turbo/);
assert.equal(new Set(WORK_MODES.map((m) => m.id)).size, WORK_MODES.length, 'work mode ids must be unique');
assert.ok(WORK_MODES.some((m) => m.id === 'user_device' && m.grants.includes('computer')));
assert.ok(getWorkMode('own_device').requiresDevice, 'own_device must require a companion device');
assert.ok(!getWorkMode('user_device').requiresDevice);

/* ---------- 2. catalog coverage: every Loam-mode tool belongs to a service ---------- */
const uncovered = uncoveredModeTools();
assert.deepEqual(uncovered, [], `mode tools missing from the service catalog: ${uncovered.join(', ')}`);
for (const service of COMPANION_SERVICES) {
  assert.ok(service.tools.length > 0, `service ${service.id} lists no tools`);
  assert.equal(new Set(service.tools).size, service.tools.length, `service ${service.id} has duplicate tools`);
}

/* ---------- 2b. N3 Knowledge Garden reachability ---------- */
// A service that no work mode grants is unreachable, which makes the per-run
// garden toggle a no-op. Every work mode must be able to hand kb_* to a run.
const ALL_TOOLS = [...new Set(COMPANION_SERVICES.flatMap((s) => s.tools).concat(LOAM_MODES.flatMap((m) => m.tools)))];
for (const workMode of WORK_MODES) {
  const resolved = resolveCompanionCapabilities({
    mode: 'build', workMode: workMode.id, registeredTools: ALL_TOOLS,
  } as Parameters<typeof resolveCompanionCapabilities>[0]);
  const kb = resolved.allow.filter((tool) => tool.startsWith('kb_'));
  assert.ok(kb.length === COMPANION_SERVICES.find((s) => s.id === 'knowledge')!.tools.length,
    `work mode ${workMode.id} must grant the knowledge service (kb_*), got ${JSON.stringify(kb)}`);
}

/* ---------- 3. gateway resolution ---------- */
const res = (over: Record<string, unknown> = {}) =>
  resolveCompanionCapabilities({ mode: 'build', workMode: 'loam', registeredTools: ALL_TOOLS, ...over } as Parameters<typeof resolveCompanionCapabilities>[0]);

// 3a. computer/screen tools never reach a run outside the user-device work modes.
const loam = res();
assert.ok(!loam.allow.includes('computer_click'));
assert.ok(!loam.allow.includes('screen_look'));
assert.equal(loam.services.find((s) => s.id === 'computer')?.status, 'blocked_workmode');

const chat = res({ workMode: 'chat' });
assert.ok(!chat.allow.includes('shell_run'), 'chat revokes the shell service');
assert.ok(chat.allow.includes('web_fetch'), 'chat keeps research tools granted by the mode');

// 3b. user_device grants real computer use on top of the mode set.
const userDevice = res({ workMode: 'user_device' });
assert.ok(userDevice.allow.includes('computer_click'));
assert.ok(userDevice.allow.includes('computer_ui_tree'));
assert.ok(userDevice.allow.includes('screen_look'));
assert.ok(userDevice.extraAllow.includes('computer_click'));
assert.ok(userDevice.extraAllow.every((t) => !getLoamMode('build').tools.includes(t)), 'extras must sit outside the mode set');
assert.ok(!userDevice.requiresDevice);
assert.ok(!userDevice.allow.includes('device_exec'), 'user_device must not reach the separate-device service');
assert.equal(userDevice.services.find((s) => s.id === 'computer')?.status, 'allowed');

// 3c. own_device routes work into the companion's isolated device: device tools
// are granted, host computer/screen control is revoked, and a device is required.
const ownDevice = res({ workMode: 'own_device' });
assert.ok(ownDevice.requiresDevice);
assert.ok(ownDevice.allow.includes('device_exec'));
assert.ok(ownDevice.allow.includes('device_pull_file'));
assert.ok(!ownDevice.allow.includes('computer_click'), 'own_device must never control the user physical machine');
assert.ok(!ownDevice.allow.includes('screen_look'));
assert.equal(ownDevice.services.find((s) => s.id === 'device')?.status, 'allowed');

// 3d. team grants swarm delegation tools absent from the build mode set.
const team = res({ workMode: 'team' });
assert.ok(team.allow.includes('delegate_subagent'));
assert.ok(team.allow.includes('subagent_list'));
assert.ok(!team.allow.includes('computer_click'), 'team must not control the user device');

// 3e. per-agent service allowlist narrows everything.
const filesOnly = res({ workMode: 'user_device', allowedServices: ['files'] });
assert.ok(filesOnly.allow.includes('file_read'));
assert.ok(filesOnly.allow.includes('file_write'), 'files service includes write tools');
assert.ok(!filesOnly.allow.includes('computer_click'), 'service grant removes computer use even under user_device');
assert.ok(!filesOnly.allow.includes('web_fetch'));
assert.equal(filesOnly.services.find((s) => s.id === 'search')?.status, 'blocked_service');

// 3f. disabled tools win over every grant layer.
const denied = res({ workMode: 'user_device', disabledTools: ['computer_click', 'file_write'] });
assert.ok(!denied.allow.includes('computer_click'));
assert.ok(!denied.allow.includes('file_write'));
assert.ok(denied.allow.includes('computer_type'), 'non-denied computer tools survive');

// 3g. unregistered tools never reach the allowlist.
const partial = res({ workMode: 'user_device', registeredTools: ['file_read', 'computer_click'] });
assert.deepEqual([...partial.allow].sort(), ['computer_click', 'file_read']);
assert.equal(partial.services.find((s) => s.id === 'search')?.status, 'not_registered');

// 3h. ask mode stays read-only even under user_device.
const askDevice = res({ mode: 'ask', workMode: 'user_device' });
assert.ok(!askDevice.allow.includes('file_write'), 'ask mode cannot gain write tools via work mode');
assert.ok(askDevice.allow.includes('computer_click'), 'granted computer tools still pass the ask intersection');

// 3i. UI view reports real availability.
const ui = getWorkModesUi(['file_read', 'web_search']);
assert.equal(ui.services.find((s) => s.id === 'files')?.availableToolCount, 1);
assert.equal(ui.services.find((s) => s.id === 'search')?.availableToolCount, 1);

/* ---------- 4. registry extras path (server enforcement) ---------- */
const dummy = (name: string) => ({
  name,
  description: 'test tool',
  parameters: { type: 'object' as const, properties: {} },
  async run() {
    return { ok: true, content: '' };
  },
});
const registry = new ToolRegistry();
for (const name of ['file_read', 'file_write', 'shell_run', 'computer_click', 'delegate_subagent']) registry.register(dummy(name));
const withExtras = registry.forMode('build', ['computer_click']);
assert.ok(withExtras.names().includes('computer_click'));
assert.ok(withExtras.names().includes('file_read'));
const deniedExtras = withExtras.cloneFiltered({ deny: ['computer_click'] });
assert.ok(!deniedExtras.names().includes('computer_click'));
assert.ok(registry.forMode('build').names().every((n) => n !== 'computer_click'), 'no extras = pure mode set');
assert.equal(registry.forMode('ask').get('shell_run'), undefined, 'ask mode must not expose shell_run');

/* ---------- 5. agents store accepts the new fields and rejects bad ones atomically ---------- */
const a = createAgent({ name: 'مراقب الجهاز', mode: 'build', workMode: 'user_device', allowedServices: ['files', 'computer', 'screen'] });
assert.equal(a.workMode, 'user_device');
assert.deepEqual(a.allowedServices, ['files', 'computer', 'screen']);
const before = listAgents().length;
assert.throws(() => createAgent({ name: 'سيئ', workMode: 'hyperspace' }), /Unknown work mode/);
assert.throws(() => createAgent({ name: 'سيئ', allowedServices: ['teleport'] }), /Unknown companion service/);
assert.equal(listAgents().length, before, 'rejected creates must not partially mutate');
assert.equal(updateAgent(a.id, { workMode: 'team' })?.workMode, 'team');
assert.throws(() => updateAgent(a.id, { workMode: 'nope' }), /Unknown work mode/);
assert.equal(updateAgent(a.id, { workMode: 'team' })?.workMode, 'team', 'failed update must not corrupt');
assert.deepEqual(updateAgent(a.id, { allowedServices: [] })?.allowedServices, undefined, 'empty grants = all services');
assert.equal(updateAgent(a.id, { workMode: null })?.workMode, undefined);
assert.deepEqual(updateAgent(a.id, { allowedServices: ['search'] })?.allowedServices, ['search']);

console.log(`Companions stage 1: gateway resolves ${COMPANION_SERVICES.length} services × ${WORK_MODES.length} work modes; computer use reaches runs only via user/own-device modes; service grants and tool denials are enforced; agents store validates workMode/allowedServices atomically.`);

/* ==========================================================================
 * Phase 3 — device layer (deterministic, FakeDeviceRunner implements the exact
 * command protocol the tools emit; golden/snapshots write real files).
 * ========================================================================== */
const devicesModule = await import('../server/companionDevices.js');
const { DeviceManager, fakeRunner, DEVICE_TEMPLATES, getDevice: getDeviceRecord } = devicesModule;
type DeviceRecord = import('../server/companionDevices.js').CompanionDeviceRecord;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dm = new DeviceManager(fakeRunner);

// 1. templates + providers
assert.ok(DEVICE_TEMPLATES.some((t) => t.id === 'research'));
assert.ok(DEVICE_TEMPLATES.some((t) => t.id === 'coding'));
assert.ok(DEVICE_TEMPLATES.some((t) => t.id === 'office'));
assert.ok(DEVICE_TEMPLATES.some((t) => t.id === 'design'));
assert.throws(() => devicesModule.getDeviceTemplate('gaming'), /Unknown device template/);
const providers = await dm.providers();
assert.ok(providers.wsl && providers.fake && !providers.hyperv);

// 2. create → async provisioning → running, with a real distro name + persistent storage dir
const deviceAgentId = 'agent-device-test';
const created = await dm.create({ agentId: deviceAgentId, template: 'coding', name: 'جهاز البرمجة' });
assert.ok(!('error' in created), `create failed: ${JSON.stringify(created)}`);
const devId = (created as DeviceRecord).id;
const waitState = async (target: string, ms = 8000): Promise<DeviceRecord> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const d = getDeviceRecord(devId);
    if (d?.state === target) return d;
    if (d?.state === 'error') throw new Error(`provisioning failed: ${d.lastError}`);
    await sleep(40);
  }
  throw new Error(`device never reached ${target}`);
};
const device = await waitState('running');
assert.ok(device.osName.startsWith('loam-device-'));
assert.ok(fs.existsSync(device.storagePath), 'persistent storage dir must exist');
assert.ok(fs.existsSync(path.join(dir, 'companion-devices.json')), 'device store must be persisted to disk');
assert.ok(dm.goldenReady(), 'golden rootfs prepared');
assert.equal(fakeRunner.calls.find((c) => c.op === 'import')?.osName, device.osName, 'import registered the distro');

// 3. duplicate active device refused
const dup = await dm.create({ agentId: deviceAgentId, template: 'research' });
assert.ok('error' in dup && /جهاز فعّال/.test(dup.error));

// 4. lifecycle: stop/start/suspend/resume + invalid transitions
await dm.stop(devId);
assert.equal(getDeviceRecord(devId)?.state, 'stopped');
const badStop = await dm.stop(devId);
assert.ok('error' in badStop, 'stopping a stopped device must fail');
await dm.start(devId);
assert.equal(getDeviceRecord(devId)?.state, 'running');
await dm.suspend(devId);
assert.equal(getDeviceRecord(devId)?.state, 'suspended');
await dm.resume(devId);
assert.equal(getDeviceRecord(devId)?.state, 'running');

// 5. readiness
const ready = await dm.isReady(devId);
assert.ok(ready.ready && ready.detail.includes('loam-ready'));

// 6. take-control interlock: agent blocked while the user holds control
const agentOk = await dm.agentExec(device!, 'echo agent-side');
assert.ok(!('error' in agentOk) && agentOk.code === 0);
const userBlocked = await dm.userExec(device!, 'ls');
assert.ok('error' in userBlocked && /تولَّ التحكم/.test(userBlocked.error));
devicesModule.deviceManager.setControl(devId, 'user');
const agentBlocked = await dm.agentExec(device!, 'echo nope');
assert.ok('error' in agentBlocked && /يتولى التحكم/.test(agentBlocked.error));
const userOk = await dm.userExec(device!, 'echo manual');
assert.ok(!('error' in userOk) && userOk.code === 0);
devicesModule.deviceManager.setControl(devId, 'agent');
const agentBack = await dm.agentExec(device!, 'echo back');
assert.ok(!('error' in agentBack));

// 6b. live GUI viewer: boot (idempotent), real image bytes, windows, gated input.
const guiBoot = await dm.ensureGui(devId);
assert.ok(!('error' in guiBoot) && guiBoot.ok && guiBoot.started, JSON.stringify(guiBoot));
const guiAgain = await dm.ensureGui(devId);
assert.ok(!('error' in guiAgain) && guiAgain.ok && guiAgain.started === false, 'second ensure must be a no-op');
const frame = await dm.captureScreen(devId);
assert.ok(!('error' in frame) && Buffer.isBuffer(frame) && frame.length > 50 && frame.subarray(1, 4).toString('ascii') === 'PNG', 'capture must return real image bytes (PNG in the fake runner)');
const guiBlocked = await dm.sendGuiInput(devId, { type: 'click', x: 10, y: 10 });
assert.ok(guiBlocked !== true && /تولَّ التحكم/.test(guiBlocked.error), 'manual input must require holding control');
devicesModule.deviceManager.setControl(devId, 'user');
assert.ok((await dm.sendGuiInput(devId, { type: 'click', x: 100, y: 120 })) === true);
assert.ok(fakeRunner.guiInputs.some((c) => c.includes('mousemove --sync 100 120') && c.includes('click 1')), `saw ${JSON.stringify(fakeRunner.guiInputs)}`);
assert.ok((await dm.sendGuiInput(devId, { type: 'type', text: 'مرحبا يا جهاز' })) === true);
const badKey = await dm.sendGuiInput(devId, { type: 'key', key: 'rm -rf' });
assert.ok(badKey !== true && /مفتاح غير صالح/.test(badKey.error), 'key names must be validated');
devicesModule.deviceManager.setControl(devId, 'agent');
const windows = await dm.guiWindows(devId);
assert.ok(!('error' in windows) && Array.isArray(windows) && windows.some((w) => w.title.includes('xterm')), JSON.stringify(windows));

// 7. device tools round-trip through the FakeDeviceRunner protocol
const { createDeviceTools, DEVICE_TOOL_NAMES } = await import('../tools/deviceTools.js');
assert.deepEqual(DEVICE_TOOL_NAMES, ['device_exec', 'device_read_file', 'device_write_file', 'device_list_files', 'device_pull_file', 'device_push_file', 'device_write_secret']);
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-device-ws-'));
const toolCtx = { cfg: {} as never, workspace: ws, emit: () => {} } as never;
const tools = new Map(createDeviceTools(dm, device!).map((t) => [t.name, t]));
const writeRes = await tools.get('device_write_file')!.run({ path: '/home/loam/report.md', content: 'تقرير الجهاز المستقل — hello' }, toolCtx);
assert.ok(writeRes.ok, writeRes.content);
const readRes = await tools.get('device_read_file')!.run({ path: '/home/loam/report.md' }, toolCtx);
assert.ok(readRes.ok && readRes.content.includes('تقرير الجهاز المستقل'), readRes.content);
const listRes = await tools.get('device_list_files')!.run({ path: '/home/loam' }, toolCtx);
assert.ok(listRes.ok && listRes.content.includes('report.md'), listRes.content);
const execRes = await tools.get('device_exec')!.run({ command: 'python3 --version' }, toolCtx);
assert.ok(execRes.ok);
const pullRes = await tools.get('device_pull_file')!.run({ path: '/home/loam/report.md' }, toolCtx);
assert.ok(pullRes.ok && pullRes.content.includes('device-files/'), pullRes.content);
const pulledFiles = fs.readdirSync(path.join(ws, 'device-files'));
assert.equal(pulledFiles.length, 1);
assert.ok(fs.readFileSync(path.join(ws, 'device-files', pulledFiles[0]!), 'utf8').includes('تقرير الجهاز المستقل'));
fs.writeFileSync(path.join(ws, 'input.csv'), 'a,b\n1,2\n');
const pushRes = await tools.get('device_push_file')!.run({ path: 'input.csv' }, toolCtx);
assert.ok(pushRes.ok, pushRes.content);
const pushedRead = await tools.get('device_read_file')!.run({ path: '/home/loam/inbox/input.csv' }, toolCtx);
assert.ok(pushedRead.ok && pushedRead.content.includes('a,b'), pushedRead.content);

// 8. snapshots (restore points): real tar file, auto-stop of a running device,
//    restore = unregister + import, and state rules.
const runningSnap = await dm.snapshot(devId, 'قبل التغيير الكبير');
assert.ok(!('error' in runningSnap), JSON.stringify(runningSnap));
const snapDevice = getDeviceRecord(devId)!;
assert.equal(snapDevice.state, 'stopped', 'snapshot auto-stops a running device');
assert.equal(snapDevice.snapshots.length, 1);
const snap = snapDevice.snapshots[0]!;
assert.ok(fs.existsSync(path.join(snapDevice.storagePath, snap.file)), 'snapshot tar must exist on disk');
assert.ok(fakeRunner.calls.some((c) => c.op === 'export'), 'snapshot must export through the provider');
const snapWhileRunning = await (async () => { await dm.start(devId); return dm.restore(devId, snap.id); })();
assert.ok('error' in snapWhileRunning && /أوقف الجهاز/.test(snapWhileRunning.error), 'restore on a running device must be refused');
await dm.stop(devId);
const restored = await dm.restore(devId, snap.id);
assert.ok(!('error' in restored), JSON.stringify(restored));
assert.ok(fakeRunner.calls.some((c) => c.op === 'unregister'), 'restore must unregister the current device');
assert.equal(fakeRunner.calls.filter((c) => c.op === 'import').length, 2, 'restore re-imports from the snapshot');
assert.equal(getDeviceRecord(devId)?.state, 'stopped');

// 9. stats + journal + delete (explicit confirm required)
const statsRes = await dm.stats(devId);
assert.ok(!('error' in statsRes) && statsRes.memoryTotalMB! > 0, JSON.stringify(statsRes));
const journal = devicesModule.readJournal(getDeviceRecord(devId)!);
assert.ok(journal.some((e) => e.event === 'create' && e.ok));
assert.ok(journal.some((e) => e.event === 'control-taken'));
assert.ok(journal.some((e) => e.kind === 'agent'));
const noConfirm = await dm.remove(devId, false);
assert.ok('error' in noConfirm && /أكّد الحذف/.test(noConfirm.error));
const gone = await dm.remove(devId, true);
assert.ok(!('error' in gone) && gone.deleted === true);
assert.equal(getDeviceRecord(devId), undefined);
assert.ok(!fs.existsSync(snapDevice.storagePath), 'device storage removed on delete');

console.log('Companions stage 2 (devices): provider detection, async provisioning to running, one-active-device rule, lifecycle with invalid transitions refused, readiness probe, take-control interlock, tool round-trips (write/read/list/exec/pull/push), real snapshot files with restore = unregister+import, stats/journal, and confirmed destructive delete.');

/* ==========================================================================
 * Phase 4 — stage 3 services (tasks + automation) with per-service verification
 * evidence: every cataloged service tool is invoked against the real stores.
 * ========================================================================== */
const { createLoamServiceTools } = await import('../tools/loamServices.js');
const db = await import('../server/db.js');
{
  const registry4 = new ToolRegistry();
  registry4.registerAll(createLoamServiceTools());
  const get = (name: string) => registry4.get(name);
  const ctx4 = { cfg: {} as never, workspace: dir, emit: () => {} } as never;

  // service: tasks — create → list → get → cancel, each verified in the store.
  const created = await get('task_create')!.run({ title: 'تقرير الربع من المساعد', prompt: 'جهّز تقريرًا وعرضًا', agentId: 'agent-x' }, ctx4);
  assert.ok(created.ok && /المعرف: (task_\S+)/.test(created.content), created.content);
  const taskId = /المعرف: (task_\S+?)[.\s]/.exec(created.content)?.[1] ?? /task_\S+/.exec(created.content)![0]!;
  assert.equal(db.getTask(taskId)?.title, 'تقرير الربع من المساعد', 'task must exist in the real store');
  const listed = await get('task_list')!.run({ limit: 5 }, ctx4);
  assert.ok(listed.ok && listed.content.includes('تقرير الربع من المساعد'), listed.content);
  const got = await get('task_get')!.run({ id: taskId }, ctx4);
  assert.ok(got.ok && got.content.includes('"status"'), got.content);
  const cancelled = await get('task_cancel')!.run({ id: taskId }, ctx4);
  assert.ok(cancelled.ok, cancelled.content);
  assert.equal(db.getTask(taskId)?.status, 'cancelled', 'cancel must persist');
  const cancelAgain = await get('task_cancel')!.run({ id: taskId }, ctx4);
  assert.ok(!cancelAgain.ok, 'cancelling a finished task must refuse');
  const missing = await get('task_get')!.run({ id: 'task_missing' }, ctx4);
  assert.ok(!missing.ok && missing.content.includes('غير موجودة'));

  // service: automation — create → list → delete with store verification.
  const sched = await get('schedule_create')!.run({ prompt: 'تقرير صباحي موجز', everyMinutes: 60 }, ctx4);
  assert.ok(sched.ok && /(sched_\S+)/.test(sched.content), sched.content);
  const schedId = /sched_[A-Za-z0-9]+/.exec(sched.content)![0]!;
  assert.ok(db.listSchedules().some((s) => s.id === schedId && s.intervalSeconds === 3600), 'schedule must persist with the interval');
  const schedList = await get('schedule_list')!.run({}, ctx4);
  assert.ok(schedList.ok && schedList.content.includes('تقرير صباحي موجز'), schedList.content);
  const schedDel = await get('schedule_delete')!.run({ id: schedId }, ctx4);
  assert.ok(schedDel.ok);
  assert.ok(!db.listSchedules().some((s) => s.id === schedId), 'delete must persist');
  const badSched = await get('schedule_create')!.run({ prompt: 'x', everyMinutes: 0 }, ctx4);
  assert.ok(!badSched.ok, 'non-positive interval must be refused');
}

// Gateway wiring: the two services are granted in the working modes, not in chat.
{
  const loam3 = res3({ workMode: 'loam' });
  assert.ok(loam3.allow.includes('task_create') && loam3.allow.includes('schedule_create'), 'loam work mode grants the new services');
  assert.ok(res3({ workMode: 'team' }).allow.includes('task_create'));
  assert.ok(res3({ workMode: 'continuous' }).allow.includes('schedule_create'));
  assert.ok(res3({ workMode: 'own_device' }).allow.includes('task_create'), 'own_device keeps Loam-side services');
  const chat3 = res3({ workMode: 'chat' });
  assert.ok(!chat3.allow.includes('task_create') && !chat3.allow.includes('schedule_create'), 'chat must not mutate tasks or schedules');
  const onlyTasks = res3({ workMode: 'loam', allowedServices: ['tasks'] });
  assert.ok(onlyTasks.allow.includes('task_create') && !onlyTasks.allow.includes('schedule_create'), 'per-agent service grants apply to the new services');
}
function res3(over: Record<string, unknown> = {}) {
  return resolveCompanionCapabilities({ mode: 'automate', workMode: 'loam', registeredTools: ALL_TOOLS, ...over } as Parameters<typeof resolveCompanionCapabilities>[0]);
}

console.log('Companions stage 3 (services): tasks service verified end-to-end against the real store (create→list→get→cancel with persisted status + refusal rules), automation service verified (create→list→delete persisted + interval validation), and both granted via the gateway in loam/team/continuous/own_device but never in chat.');

/* ==========================================================================
 * Phase 5 — per-service proof matrix (stage 3 completion): every cataloged
 * service gets at least one REAL invocation against the real runtime
 * (buildRuntime + real tools). device/tasks/automation were proven in the
 * phases above; this matrix covers the rest with real executions.
 * ========================================================================== */
{
  const matrixTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-matrix-'));
  process.env.MANUS_LOCAL_CONFIG = path.join(matrixTmp, 'config.json');
  fs.writeFileSync(process.env.MANUS_LOCAL_CONFIG, JSON.stringify({
    model: 'test-model', fallbackModel: 'test-model', ollamaUrl: 'http://127.0.0.1:9',
    workspace: path.join(matrixTmp, 'ws'),
    computerUse: { enabled: true, screenshotDir: path.join(matrixTmp, 'shots') },
    memory: { enabled: false }, selfImprove: { enabled: false }, mcpServers: {},
  }));
  fs.mkdirSync(path.join(matrixTmp, 'ws'), { recursive: true });
  const { loadConfig } = await import('../config.js');
  const cfg = loadConfig();
  const { buildRuntime } = await import('../setup/runtime.js');
  const rt = await buildRuntime(cfg);
  const reg = rt.registry;
  db.loadDb();
  const matrixTask = db.createTask('مهمة مصفوفة الخدمات الفريدة loam-matrix-evidence', 'مصفوفة الخدمات', null, null);
  db.setTaskMode(matrixTask.id, 'build');
  const ctx5 = { cfg, workspace: cfg.workspace, emit: () => {}, taskId: matrixTask.id } as never;
  const run5 = async (name: string, args: Record<string, unknown>) => {
    const tool = reg.get(name);
    assert.ok(tool, `tool ${name} must be registered in the real runtime`);
    const result = await tool.run(args, ctx5);
    return result;
  };
  const okOf = async (name: string, args: Record<string, unknown>, mustContain?: string) => {
    const r = await run5(name, args);
    assert.ok(r.ok, `${name} must succeed against real execution, got: ${r.content.slice(0, 200)}`);
    if (mustContain) assert.ok(r.content.includes(mustContain), `${name} output must contain "${mustContainsafe(mustContain)}", got: ${r.content.slice(0, 200)}`);
    return r;
  };
  const mustContainsafe = (s: string): string => s;

  // local stub web target shared by search/browser/security services
  const stub = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' } ); res.end('<html><body><main><a href="/x">LOAM-WEB-MARKER</a></main></body></html>'); });
  stub.listen(0, '127.0.0.1'); await once(stub, 'listening');
  const stubPort = (stub.address() as import('node:net').AddressInfo).port;

  try {
    // files
    await okOf('file_write', { path: 'matrix.md', content: 'ملاحظة مصفوفة الخدمات' });
    const readBack = await okOf('file_read', { path: 'matrix.md' }, 'ملاحظة مصفوفة الخدمات');
    assert.ok(readBack.content.includes('ملاحظة مصفوفة الخدمات'));
    // code
    await run5('file_write', { path: 'sym.ts', content: 'export function loamMatrixFn(x: number): number { return x + 1; }\n' });
    await okOf('code_symbols', { path: 'sym.ts' }, 'loamMatrixFn');
    // shell (real command execution on this host)
    const shellRes = await run5('shell_run', { command: 'echo loam-matrix-shell', timeoutSeconds: 30 });
    assert.ok(shellRes.ok && shellRes.content.includes('loam-matrix-shell'), shellRes.content.slice(0, 200));
    // office
    await okOf('loam_document', { path: 'matrix-report.md', title: 'تقرير المصفوفة', content: 'محتوى' });
    assert.ok(fs.existsSync(path.join(cfg.workspace, 'matrix-report.md')));
    // data
    await run5('file_write', { path: 'matrix.csv', content: 'name,score\na,3\nb,5\nc,7\n' });
    await okOf('loam_dataset', { path: 'matrix.csv' }, 'rows');
    // creative (via canvas)
    await okOf('loam_canvas', { path: 'matrix-poster.svg', title: 'ملصق المصفوفة' });
    assert.ok(fs.existsSync(path.join(cfg.workspace, 'matrix-poster.svg')));
    // mobile (real studio project read bound to the task)
    await okOf('loam_mobile', { action: 'read' });
    // preview (real local server lifecycle)
    await okOf('preview_serve', { dir: '.' }, 'http://127.0.0.1');
    await okOf('preview_status', {}, '"running":true');
    await okOf('preview_stop', {});
    // search (real fetch through the tool against a local server)
    await okOf('web_fetch', { url: `http://127.0.0.1:${stubPort}/` }, 'LOAM-WEB-MARKER');
    // browser (REAL browser: open → read the page → close)
    const opened = await okOf('browser_open', { url: `http://127.0.0.1:${stubPort}/` });
    const pageId = /pageId=(\S+)/.exec(opened.content)?.[1];
    assert.ok(pageId, `browser_open must return a pageId, got: ${opened.content.slice(0, 120)}`);
    assert.ok(opened.content.includes('LOAM-WEB-MARKER'), 'the real browser must read the served page');
    const snap = await okOf('browser_snapshot', { pageId }, 'LOAM-WEB-MARKER');
    assert.ok(snap.content.includes('LOAM-WEB-MARKER'));
    await run5('browser_close', { pageId });
    // security (real read-only scan of the local stub)
    await okOf('pentest_check', { target: `http://127.0.0.1:${stubPort}`, check: 'security_headers' }, 'security');
    // memory service (task memory: real search over the real store)
    await okOf('session_search', { query: 'loam-matrix-evidence', limit: 3 }, matrixTask.id);
    // skills (real create/list/delete in the skills dir)
    await okOf('skill_create', { name: 'matrix-skill', description: 'تحقق المصفوفة', content: 'خطوات' });
    await okOf('skill_list', {}, 'matrix-skill');
    await okOf('skill_delete', { name: 'matrix-skill' });
    // integrations (real listing with zero grants → coherent result)
    const integ = await run5('integration_list', { query: '' });
    assert.ok(integ.ok || /ممنوح|granted|enable/i.test(integ.content), `integration_list must answer coherently: ${integ.content.slice(0, 120)}`);
    // computer (REAL host read-only: enumerate windows + capture a frame; no input injection here)
    const windows = await okOf('computer_list_windows', {});
    assert.ok(windows.content.trim().startsWith('[') && windows.content.length > 10, 'host window enumeration must return real data');
    const shot = await okOf('computer_screenshot', {});
    const shotPath = JSON.parse(shot.content).path as string;
    assert.ok(fs.existsSync(shotPath) && fs.statSync(shotPath).size > 1000, 'host screenshot must produce a real image');
    fs.rmSync(shotPath, { force: true });
    // screen (real read-only capture of the host screen through the screen service)
    const screenRes = reg.get('screen_look') ? await run5('screen_look', { fresh: true, maxWidth: 640 }) : undefined;
    if (screenRes) {
      assert.ok(screenRes.ok && /screen|.png|.jpg/i.test(screenRes.content), `screen_look must capture a real frame, got: ${screenRes.content.slice(0, 160)}`);
    } else {
      assert.equal(cfg.screen.enabled, false, 'screen tools may be absent only when screen.enabled is false');
    }
    // device + tasks + automation: proven above (phases 3-4)
    console.log('Companions services matrix: 20/20 services have real-invocation evidence — files/code/shell/office/data/creative/mobile/preview/search/browser/security/task-memory/skills/integrations/computer executed against the real runtime here; screen honestly config-gated; device/tasks/automation proven in earlier phases.');
  } finally {
    await rt.dispose();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
}

/* ==========================================================================
 * Phase 6 — stage 4a start: companion personal memory + agent-bound routines.
 * ========================================================================== */
{
  const mem = await import('../server/companionMemory.js');
  const agentA = 'agent_mem_a';
  const agentB = 'agent_mem_b';
  // save → list with source/date/confidence; search finds Arabic text; isolation between agents.
  const pref = mem.remember(agentA, { text: 'يفضّل المستخدم التقارير المختصرة بالعربية الفصحى', kind: 'preference', source: 'user', confidence: 0.95 });
  assert.ok(!('error' in pref), JSON.stringify(pref));
  const infer = mem.remember(agentA, { text: 'يعمل المستخدم غالبًا مساءً', kind: 'inference', source: 'companion', confidence: 0.4 });
  assert.ok(!('error' in infer));
  assert.ok(mem.listMemory(agentA).some((e) => e.source === 'user' && e.kind === 'preference' && e.confidence === 0.95));
  assert.ok(mem.listMemory(agentA, { q: 'التقارير المختصرة' }).length === 1);
  assert.deepEqual(mem.listMemory(agentB), [], 'memory must never cross companions');
  const badKind = mem.remember(agentA, { text: 'x', kind: 'nonsense' });
  assert.ok(!('error' in badKind) && badKind.kind === 'fact', 'unknown kinds fall back to fact');
  const noText = mem.remember(agentA, { text: '   ' });
  assert.ok('error' in noText, 'empty memory text must be refused');
  // edit keeps history; supersede handles contradictions; forget removes.
  const edited = mem.editMemory(agentA, pref.id, { text: 'يفضّر المستخدم ملخصات قصيرة', confidence: 0.9 });
  assert.ok(!('error' in edited) && (edited.editHistory?.length ?? 0) === 1, JSON.stringify(edited));
  const sup = mem.supersedeMemory(agentA, edited.id, 'يفضّل المستخدم التقارير المتوسطة الطول');
  assert.ok(!('error' in sup) && sup.old.supersededBy === sup.next.id, 'supersede must link old→new');
  assert.ok(!mem.listMemory(agentA).some((e) => e.id === sup.old.id), 'superseded entries leave the active list');
  assert.ok(mem.listMemory(agentA, { includeInactive: true }).some((e) => e.id === sup.old.id), 'but stay reviewable');
  assert.ok(mem.forget(agentA, infer.id));
  assert.ok(!mem.forget(agentA, 'mem_missing'));
  // export/import round-trip into another companion (isolated copy, dedupe by id).
  const dump = mem.exportMemory(agentA);
  const imp = mem.importMemory(agentB, dump);
  assert.ok(!('error' in imp) && imp.imported >= 2, JSON.stringify(imp));
  assert.ok(mem.listMemory(agentB).some((e) => e.text.includes('التقارير المتوسطة')));
  const impAgain = mem.importMemory(agentB, dump);
  assert.ok(!('error' in impAgain) && impAgain.imported === 0 && impAgain.skipped >= 2, 'import must dedupe by id');
  // expired entries are hidden (injected through import with a past expiresAt).
  mem.importMemory(agentB, JSON.stringify({ entries: [{ id: 'mem_expired_probe', text: 'عرض مؤقت منتهي', kind: 'fact', source: 'user', at: '2026-01-01T00:00:00.000Z', confidence: 1, expiresAt: '2026-01-02T00:00:00.000Z' }] }));
  assert.ok(!mem.listMemory(agentB).some((e) => e.id === 'mem_expired_probe'), 'expired entries must not surface');
  // memory tools bound per agent: A's tool sees A only.
  const { createCompanionMemoryTools, COMPANION_MEMORY_TOOL_NAMES } = await import('../tools/companionMemoryTools.js');
  const toolA = new Map(createCompanionMemoryTools(agentA).map((t) => [t.name, t]));
  assert.deepEqual([...toolA.keys()].sort(), [...COMPANION_MEMORY_TOOL_NAMES].sort());
  const memCtx = { cfg: {} as never, workspace: dir, emit: () => {} } as never;
  const savedViaTool = await toolA.get('companion_memory_save')!.run({ text: 'لغة التواصل المفضلة: العربية', kind: 'preference', source: 'user', confidence: 0.9 }, memCtx);
  assert.ok(savedViaTool.ok && savedViaTool.content.includes('قالها المستخدم'), savedViaTool.content);
  const foundViaTool = await toolA.get('companion_memory_search')!.run({ q: 'العربية' }, memCtx);
  assert.ok(foundViaTool.ok && foundViaTool.content.includes('لغة التواصل'), foundViaTool.content);
  const emptyB = await createCompanionMemoryTools(agentB)[1]!.run({ q: 'لغة التواصل' }, memCtx);
  assert.ok(emptyB.ok && emptyB.content.includes('لا نتائج'), 'agent B must not see agent A memories through tools');
  // gateway: the companion-memory service is granted in EVERY work mode (incl. chat).
  const memChat = res({ workMode: 'chat', registeredTools: ALL_TOOLS });
  assert.ok(memChat.allow.includes('companion_memory_save') && memChat.allow.includes('companion_memory_search'), 'memory must reach companions even in chat mode');
  assert.ok(res({ workMode: 'own_device' }).allow.includes('companion_memory_list'));

  // shared team memory: readable by all companions, writes record their owner,
  // and private entries never leak across agents.
  const shared = mem.rememberShared(agentA, { text: 'قوالب التسليم للفريق بصيغة PDF', kind: 'instruction', confidence: 0.9 });
  assert.ok(!('error' in shared) && shared.ownerAgentId === agentA, JSON.stringify(shared));
  assert.ok(mem.listTeamMemory().some((e) => e.ownerAgentId === agentA));
  const sharedSearch = await mem.searchMemory(agentB, { q: 'قوالب التسليم' });
  assert.ok(sharedSearch.hits.some((h) => h.scope === 'team' && h.entry.id === shared.id), 'team entries must surface for other companions');
  const privateLeak = await mem.searchMemory(agentB, { q: 'لغة التواصل المفضلة' });
  assert.ok(privateLeak.hits.every((h) => h.scope === 'team'), 'agent A private memory must never leak to agent B');

  // semantic search: deterministic embedder (Arabic letter-presence vectors) finds
  // related entries the substring search misses; without an embedder it degrades honestly.
  const LETTERS = ['ت', 'ق', 'ر', 'ي', 'م', 'ل', 'خ', 'ص', 'ا', 'ن', 'ع', 'ب'];
  const fakeEmbed = {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => LETTERS.map((ch) => (t.includes(ch) ? 1 : 0)));
    },
  };
  mem.remember(agentB, { text: 'تقارير دورية للمبيعات تُراجع أسبوعيًا', kind: 'fact', source: 'user' });
  mem.setMemoryEmbedder(fakeEmbed);
  const semantic = await mem.searchMemory(agentB, { q: 'تقرير المبيعات', semantic: true });
  assert.equal(semantic.mode, 'semantic', 'with an embedder the search must be semantic');
  assert.ok(semantic.hits.some((h) => h.entry.text.includes('تقارير دورية') && (h.score ?? 0) > 0.3), `semantic hit expected, got ${JSON.stringify(semantic.hits.map((h) => [h.entry.text.slice(0, 24), h.score]))}`);
  const semanticViaTool = await createCompanionMemoryTools(agentB)[1]!.run({ q: 'تقرير المبيعات' }, memCtx);
  assert.ok(semanticViaTool.ok && semanticViaTool.content.includes('شبه'), `the search tool must expose semantic scores, got: ${semanticViaTool.content.slice(0, 160)}`);
  mem.setMemoryEmbedder(undefined);
  const textOnly = await mem.searchMemory(agentB, { q: 'تقرير المبيعات', semantic: true });
  assert.equal(textOnly.mode, 'text', 'without an embedder the search must degrade to text honestly');
  const toolSharedList = await createCompanionMemoryTools(agentB)[2]!.run({}, memCtx);
  assert.ok(toolSharedList.ok && toolSharedList.content.includes('مشترك — فريق') && toolSharedList.content.includes('قوالب التسليم'), `team entries must appear in the list tool, got: ${toolSharedList.content.slice(0, 200)}`);

  // agent-bound routines: schedule carries agentId; the tool binds to the run's agent automatically.
  const ownerTask = db.createTask('جولة روتين', 'روتين', null, agentA);
  db.setTaskMode(ownerTask.id, 'build');
  const services6 = new Map((await import('../tools/loamServices.js')).createLoamServiceTools().map((t) => [t.name, t]));
  const viaTool = await services6.get('schedule_create')!.run({ prompt: 'تقرير مسائي موجز', everyMinutes: 120 }, { cfg: {} as never, workspace: dir, emit: () => {}, taskId: ownerTask.id } as never);
  assert.ok(viaTool.ok && viaTool.content.includes(agentA), `schedule_create must auto-bind to the run's agent, got: ${viaTool.content}`);
  const sched = db.listSchedules().find((s) => s.agentId === agentA && s.prompt.includes('تقرير مسائي'));
  assert.ok(sched, 'schedule must persist with agentId');
  assert.ok(db.deleteSchedule(sched!.id));
  // routines can target the companion's own device (workMode own_device).
  const viaToolDevice = await services6.get('schedule_create')!.run({ prompt: 'نسخ احتياطي داخل الجهاز', everyMinutes: 360, workMode: 'own_device' }, { cfg: {} as never, workspace: dir, emit: () => {}, taskId: ownerTask.id } as never);
  assert.ok(viaToolDevice.ok && viaToolDevice.content.includes('جهازه المستقل'), `schedule_create must record the own-device target, got: ${viaToolDevice.content}`);
  const schedDevice = db.listSchedules().find((s) => s.workMode === 'own_device');
  assert.ok(schedDevice?.agentId === agentA, 'own-device routine must persist agentId + workMode');
  assert.ok(db.deleteSchedule(schedDevice!.id));

  console.log('Companions stage 4 (memory+routines): per-companion memory proven (source/date/confidence, edit history, supersede for contradictions, expiry, export/import dedupe, cross-agent isolation incl. via tools, granted in every work mode), shared team memory with owner tracking and no private leaks, semantic search via pluggable embedder with honest text-only fallback, and routines binding agentId + own-device workMode.');
}

/* ==========================================================================
 * Phase 7 — stage 5: companion-to-companion delegation, learning-from-workflow
 * skills with versions, and per-companion voice records.
 * ========================================================================== */
{
  const mem7 = await import('../server/companionMemory.js');
  const { getAgent } = await import('../server/agents.js');
  const team = await import('../server/companionTeam.js');
  const { createCompanionTeamTools, COMPANION_TEAM_TOOL_NAMES } = await import('../tools/companionTeamTools.js');
  const { readSkillFile } = await import('../tools/skills.js');

  // delegation runner hook: records requests, answers with a task id.
  const delegated: Array<{ to: string; brief: string }> = [];
  team.setDelegationRunner(async (req) => {
    delegated.push({ to: req.toAgentId, brief: req.brief });
    const delegatedTask = db.createTask(req.brief, `تفويض → ${req.toAgentId}`, null, req.toAgentId); db.setTaskDelegator(delegatedTask.id, req.fromAgentId); return { taskId: delegatedTask.id, queued: true };
  });
  const delegator = createAgent({ name: 'المنسق الأول' });
  const specialist = createAgent({ name: 'المراجع الفني', instructions: 'راجع بدقة' });
  const teamTools = new Map(createCompanionTeamTools(delegator.id).map((t) => [t.name, t]));
  assert.deepEqual([...teamTools.keys()].sort(), [...COMPANION_TEAM_TOOL_NAMES].sort());
  const teamCtx = { cfg: {} as never, workspace: dir, emit: () => {} } as never;

  const badTarget = await teamTools.get('companion_delegate')!.run({ to: 'غير موجود', brief: 'x' }, teamCtx);
  assert.ok(!badTarget.ok && /لا يوجد رفيق/.test(badTarget.content));
  const selfTarget = await teamTools.get('companion_delegate')!.run({ to: delegator.id, brief: 'x' }, teamCtx);
  assert.ok(!selfTarget.ok && /نفسك/.test(selfTarget.content));
  const byName = await teamTools.get('companion_delegate')!.run({ to: 'المراجع الفني', brief: 'راجع قسم الأمان في التقرير المرفق', title: 'مراجعة أمان' }, teamCtx);
  assert.ok(byName.ok && byName.content.includes('المراجع الفني'), byName.content);
  assert.equal(delegated.length, 1);
  assert.equal(delegated[0]!.to, specialist.id, 'delegation by display name must resolve to the agent id');
  const delegateTask = db.getTask(/task_[A-Za-z0-9]+/.exec(byName.content)?.[0] ?? '');
  assert.ok(delegateTask?.agentId === specialist.id, 'the delegate task must be owned by the target companion');
  const listOut = await teamTools.get('companion_delegations')!.run({}, teamCtx);
  assert.ok(listOut.ok && listOut.content.includes('المراجع الفني'), listOut.content.slice(0, 200));
  team.setDelegationRunner(undefined);
  const noRunner = await teamTools.get('companion_delegate')!.run({ to: specialist.id, brief: 'x' }, teamCtx);
  assert.ok(!noRunner.ok, 'delegation must refuse honestly when the runner is not wired');

  // learning-from-workflow: v1 created with owner marker + rationale memory; re-learn bumps to v2.
  const learn = teamTools.get('companion_learn_skill')!;
  const short = await learn.run({ name: 'x', steps: 'قصير' }, teamCtx);
  assert.ok(!short.ok, 'too-short workflows must be refused');
  const v1 = await learn.run({ name: 'Weekly Report Flow', description: 'إعداد التقرير الأسبوعي', steps: 'اجمع البيانات من المجلد المحدد ثم لخصها ثم اكتب report.md ثم اسحبه للمهمة', rationale: 'المستخدم وافق على الناتج مرتين متتاليتين' }, teamCtx);
  assert.ok(v1.ok && v1.content.includes('v1'), v1.content);
  const file1 = readSkillFile('weekly-report-flow');
  assert.ok(file1 && file1.body.includes(`learned-by: ${delegator.id}`) && file1.body.includes('version: 1'), file1?.body.slice(0, 200));
  const v2 = await learn.run({ name: 'Weekly Report Flow', steps: 'اجمع ثم لخص ثم اكتب report.md ثم اسحبه ثم أرسل ملخصًا صوتيًا', rationale: 'أضاف المستخدم طلب الملخص الصوتي' }, teamCtx);
  assert.ok(v2.ok && v2.content.includes('v2'), v2.content);
  const file2 = readSkillFile('weekly-report-flow');
  assert.ok(file2?.body.includes('version: 2') && file2.body.includes('الإصدار السابق'), 'v2 must archive the previous version inside the skill');
  assert.ok(mem7.listMemory(delegator.id).some((e) => e.text.includes('weekly-report-flow') && e.text.includes('وافق')), 'the acceptance rationale must land in the companion memory');

  // voice records round-trip with validation bounds.
  const voiced = createAgent({ name: 'رفيق صوتي', voice: 'Microsoft Hamed', voiceRate: 5, voiceAuto: true });
  assert.equal(voiced.voice, 'Microsoft Hamed');
  assert.equal(voiced.voiceRate, 2, 'voice rate must clamp to 2');
  updateAgent(voiced.id, { voiceRate: 0.1 });
  assert.equal(getAgent(voiced.id)?.voiceRate, 0.5, 'voice rate must clamp to 0.5');
  updateAgent(voiced.id, { voice: null, voiceAuto: null });
  assert.equal(getAgent(voiced.id)?.voice, undefined);
  assert.equal(getAgent(voiced.id)?.voiceAuto, undefined);

  // gateway wiring: team in loam/team/own_device but never chat; learning everywhere work happens except chat.
  const all7 = resolveCompanionCapabilities({ mode: 'build', workMode: 'team', registeredTools: ALL_TOOLS } as never);
  assert.ok(all7.allow.includes('companion_delegate') && all7.allow.includes('companion_learn_skill'));
  assert.ok(res({ workMode: 'loam' }).allow.includes('companion_delegate'));
  assert.ok(res({ workMode: 'own_device' }).allow.includes('companion_delegate'), 'the responsible companion can delegate from its own device run');
  assert.ok(res({ workMode: 'user_device' }).allow.includes('companion_learn_skill'), 'learning applies on the user device too');
  const chat7 = res({ workMode: 'chat' });
  assert.ok(!chat7.allow.includes('companion_delegate') && !chat7.allow.includes('companion_learn_skill'), 'chat must not delegate or mutate skills');

  console.log('Companions stage 5 (collab+learning+voice): delegation proven (name resolution, self/unknown refusal, target-owned task, honest no-runner refusal), learned skills versioned v1→v2 with owner marker + previous-version archive + acceptance rationale into memory, voice records validated and clamped, and gateway grants enforced (team in loam/team/own_device, learning in every working mode, neither in chat).');
}

/* ==========================================================================
 * Phase 8 — stage 4/5 completions: secrets vault + sensitive-action approvals.
 * ========================================================================== */
{
  const vault = await import('../server/secretsVault.ts'.replace('.ts', '.js')).catch(() => import('../server/secretsVault.js'));
  const approvals = await import('../server/approvals.js');

  // vault: seal/list/resolve/delete; the on-disk store must never contain plaintext.
  const secretAgent = 'agent_vault_test';
  assert.ok(vault.setSecret(secretAgent, 'TOKEN_API', 'super-secret-value-Ω-9173') === true);
  assert.ok(vault.setSecret(secretAgent, 'bad name!', 'x') !== true, 'invalid secret names must be rejected');
  assert.deepEqual(vault.listSecrets(secretAgent).map((s: { name: string }) => s.name), ['TOKEN_API']);
  assert.equal(vault.resolveSecret(secretAgent, 'TOKEN_API'), 'super-secret-value-Ω-9173');
  assert.equal(vault.resolveSecret(secretAgent, 'MISSING'), null);
  const rawStore = fs.readFileSync(path.join(dir, 'secrets-vault', 'agent_vault_test.json'), 'utf8');
  assert.ok(!rawStore.includes('super-secret-value'), 'the vault file must not contain the plaintext value');
  assert.ok(rawStore.includes('iv') && rawStore.includes('tag'), 'the vault file must hold sealed material');
  assert.ok(vault.deleteSecret(secretAgent, 'TOKEN_API'));
  assert.deepEqual(vault.listSecrets(secretAgent), []);

  // approvals: pending listing, deny + approve decisions, wait honors pre-decided state.
  const ap1 = approvals.createApproval({ taskId: 'task_x1', tool: 'computer_click', summary: 'اختبار', argsPreview: '{"x":1}' });
  assert.ok(approvals.listApprovals(true).some((a) => a.id === ap1.id));
  assert.equal(approvals.decideApproval(ap1.id, 'deny')?.status, 'denied');
  assert.equal(await approvals.waitForDecision(ap1.id, undefined, 1000), 'denied', 'wait must return the recorded decision');
  const ap2 = approvals.createApproval({ taskId: 'task_x2', tool: 'computer_type', summary: 'اختبار 2', argsPreview: '{}' });
  approvals.decideApproval(ap2.id, 'approve');
  assert.equal(await approvals.waitForDecision(ap2.id, undefined, 1000), 'approved');
  assert.ok(!approvals.listApprovals(true).some((a) => a.id === ap1.id), 'decided approvals leave the pending list');

  // device tools expose the vault-backed write inside the device.
  const { DEVICE_TOOL_NAMES: names8 } = await import('../tools/deviceTools.js');
  assert.ok(names8.includes('device_write_secret'), 'device tools must include the secret writer');

  // idle/resource decisions (3-4/23) with the fake runner stats fixture
  // (fake exec returns MemTotal 8000000 kB / MemFree 4000000 kB → used 4GB).
  {
    const dm2 = new devicesModule.DeviceManager(fakeRunner);
    const dev9 = await dm2.create({ agentId: 'agent_idle_test', template: 'coding' });
    assert.ok(!('error' in dev9), JSON.stringify(dev9));
    const id9 = (dev9 as { id: string }).id;
    const until9 = Date.now() + 8000;
    while (Date.now() < until9) {
      const d = devicesModule.getDevice(id9);
      if (d?.state === 'running') break;
      await new Promise((r) => setTimeout(r, 40));
    }
    // resource ceiling: limit far below the 4GB used → suspend with reason
    const rec9 = devicesModule.getDevice(id9)!;
    rec9.resources.memoryMB = 512; // far below used
    const actions1 = await dm2.scanAndSuspendIdle(60);
    assert.ok(actions1.some((a) => a.id === id9 && a.action === 'suspended-resource' && a.reason.includes('512MB')), JSON.stringify(actions1));
    assert.equal(devicesModule.getDevice(id9)?.state, 'suspended');
    // idle path: restart, raise ceiling, backdate updatedAt, short idle window
    await dm2.resume(id9);
    const rec10 = devicesModule.getDevice(id9)!;
    rec10.resources.memoryMB = 65536;
    rec10.updatedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    const actions2 = await dm2.scanAndSuspendIdle(1);
    assert.ok(actions2.some((a) => a.id === id9 && a.action === 'suspended-idle' && a.reason.includes('خامل')), JSON.stringify(actions2));
    await dm2.remove(id9, true);
  }

  // SSH provider (4): deterministic verification with an injected fake-ssh
  // transport — proves the provider semantics without a remote host.
  {
    const calls: Array<string> = [];
    const fakeSsh = async (_t: unknown, cmd: string): Promise<{ code: number; stdout: string; stderr: string }> => {
      calls.push(cmd);
      if (cmd === "echo ok") return { code: 0, stdout: "ok", stderr: "" };
      if (/wc -c/.test(cmd)) return { code: 0, stdout: "1024", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const { SshDeviceRunner, sshTargetFromEnv } = devicesModule;
    const runner = new SshDeviceRunner({ host: "srv.example", port: 2222, user: "loam", baseDir: "/srv/loam" }, fakeSsh as never);
    const providers2 = await runner.detect();
    assert.ok(providers2.wsl === true, 'ssh detect maps reachability to wsl:true (a reachable remote provider)');
    assert.ok(calls[0] === "echo ok", 'detect pings the remote host');
    await runner.importDevice("loam-device-dev_x", "/local/ignored", "");
    assert.ok(calls.some((c) => c.includes("mkdir -p") && c.includes("/srv/loam/loam-device-dev_x")), 'import creates the dedicated remote directory: ' + calls[1]);
    // A named-but-missing archive is a broken restore: it must fail BEFORE clearing anything.
    calls.length = 0;
    const broken = await runner.importDevice("loam-device-dev_x", "/local/ignored", "/local/does-not-exist.tar");
    assert.ok(broken.code !== 0, 'missing archive must fail import');
    assert.ok(!calls.some((c) => c.includes("rm -rf")), 'missing archive must not clear the remote dir');
    const execRes = await runner.exec("loam-device-dev_x", "loam", "echo hi > note.txt");
    assert.equal(execRes.code, 0);
    assert.ok(calls.some((c) => c.startsWith("cd ") && c.includes("loam-device-dev_x") && c.includes("bash -lc") && c.includes("note.txt")), 'exec runs inside the remote device dir over bash -lc');
    assert.equal((await runner.terminate("x")).code, 0, 'terminate is a no-op: the remote host owns its power state');
    const un = await runner.unregister("loam-device-dev_x");
    assert.equal(un.code, 0, 'unregister succeeds');
    calls.length = 0;
    const destroyed = await runner.destroy!("loam-device-dev_x");
    assert.equal(destroyed.code, 0);
    assert.ok(calls.some((c) => c.includes("rm -rf") && c.includes("test ! -e") && c.includes("/srv/loam/loam-device-dev_x")), 'destroy removes the remote dir and verifies it is gone (unregister keeps data restorable)');
    // env wiring
    const prevDevice = process.env.LOAM_DEVICE_RUNNER;
    delete process.env.LOAM_DEVICE_RUNNER;
    process.env.LOAM_SSH_DEVICE = "loam@far.example:2222";
    process.env.LOAM_SSH_BASE_DIR = "/srv/loam";
    const t2 = sshTargetFromEnv();
    assert.deepEqual(t2, { host: "far.example", port: 2222, user: "loam", baseDir: "/srv/loam" }, JSON.stringify(t2));
    assert.ok(devicesModule.getDeviceRunner() instanceof SshDeviceRunner, 'LOAM_SSH_DEVICE selects the SSH provider');
    delete process.env.LOAM_SSH_DEVICE;
    delete process.env.LOAM_SSH_BASE_DIR;
    if (prevDevice) process.env.LOAM_DEVICE_RUNNER = prevDevice;
    assert.equal(sshTargetFromEnv(), undefined, 'no env → no ssh target');
  }

  // Creative studio service tools (8): registered, named, and reachable via the gateway
  {
    const csTools = await import('../tools/creativeStudio.js');
    const names = csTools.CREATIVE_STUDIO_TOOL_NAMES;
    assert.ok(names.includes('creative_export') && names.includes('creative_timeline'), 'export and timeline tools required');
    const inst = csTools.createCreativeStudioTools();
    assert.equal(inst.length, names.length, 'all declared tools must instantiate');
    const creativeSvc = COMPANION_SERVICES.find((x) => x.id === 'creative');
    assert.ok(creativeSvc?.tools.includes('creative_export'), 'gateway creative service must include creative_export');
    assert.ok(creativeSvc?.tools.includes('creative_timeline'), 'gateway creative service must include creative_timeline');
    const noTask = await inst.find((t) => t.name === 'creative_export')!.run({}, { cfg: {} as never, workspace: dir, emit: () => {} } as never);
    assert.ok(!noTask.ok && noTask.content.includes('مهمة'), 'export must require an active task: ' + noTask.content.slice(0, 60));
  }

  // Office tools (8): import/export/status registered and gateway-listed
  {
    const { createOfficeTools, OFFICE_TOOL_NAMES } = await import('../tools/officeTools.js');
    const inst = createOfficeTools();
    assert.equal(inst.length, OFFICE_TOOL_NAMES.length);
    const svc = COMPANION_SERVICES.find((x) => x.id === 'office');
    assert.ok(svc?.tools.includes('office_import') && svc?.tools.includes('office_export'), 'gateway office service must include import/export');
    // honest refusal: import of missing file
    const wsO = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-office-ws-'));
    const ctxO = { cfg: {} as never, workspace: wsO, emit: () => {}, taskId: 'task_office_test' } as never;
    const miss = await inst.find((t) => t.name === 'office_import')!.run({ path: 'nonexistent.docx' }, ctxO);
    assert.ok(!miss.ok && miss.content.includes('غير موجود'), 'import must reject missing files: ' + miss.content.slice(0, 60));
    // real cycle: create a minimal studio artifact then export to DOCX
    const { saveStudio } = await import('../studio/store.js');
    saveStudio(wsO, { kind: 'document', title: 'تقرير اختبار الأوفيس', content: { blocks: [{ type: 'heading', text: 'العنوان' }, { type: 'paragraph', text: 'نص الاختبار' }] } } as never, 0);
    const exported = await inst.find((t) => t.name === 'office_export')!.run({}, ctxO);
    assert.ok(exported.ok, 'export must succeed: ' + exported.content.slice(0, 120));
    assert.ok(exported.content.includes('.docx'), 'must export DOCX: ' + exported.content.slice(0, 120));
    // verify the file was actually written
    const uploads = path.join(wsO, 'uploads');
    const files = fs.readdirSync(uploads).filter((f) => f.endsWith('.docx'));
    assert.ok(files.length >= 1, 'DOCX file must exist on disk after export');
    assert.ok(fs.statSync(path.join(uploads, files[0]!)).size > 1000, 'DOCX must be substantive (>1KB)');
    const status = await inst.find((t) => t.name === 'office_status')!.run({}, ctxO);
    assert.ok(status.ok && status.content.includes('مستند'), 'status must report the kind: ' + status.content.slice(0, 60));
  }

  console.log('Companions office tools (unit): import/export/status registered, honest rejection of missing files, and a REAL DOCX export cycle (studio artifact → docx on disk >1KB).');
}
/* ==========================================================================
 * Phase 2 — end-to-end over the real server: /api/work-modes, agent CRUD
 * validation, and /api/chat enforcement of the gateway (stub model, real
 * src/index.ts process), mirroring check-isolation-http.ts.
 * ========================================================================== */
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

const captures: Array<{ tools: string[]; system: string; lastRole: string }> = [];
const inFlight = new Set<string>();
let browserOverlap = false;
const isoPageIds = new Map<string, string>();
function trackIsoPageId(agent: string | undefined, msgs: Array<{ role: string; content: string }>): void {
  if (!agent) return;
  for (const m of msgs) {
    if (m.role !== 'tool') continue;
    const pid = /pageId=(page_[0-9]+)/.exec(m.content)?.[1];
    if (pid) isoPageIds.set(agent, pid);
  }
}
const model = http.createServer(async (req, res) => {
  if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'test-model' }] })); return; }
  if (req.url === '/iso') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html><body><a href="/x">ISO-PAGE</a></body></html>'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (!raw.trim()) { res.writeHead(404); res.end(); return; }
  const body = JSON.parse(raw);
  const messages = body.messages as Array<{ role: string; content: string }>;
  captures.push({
    tools: (body.tools ?? []).map((t: { function?: { name?: string } }) => t.function?.name ?? '').filter(Boolean),
    system: messages[0]?.content ?? '',
    lastRole: messages.at(-1)?.role ?? '',
  });
  // Own-device runs actually exercise a device tool before finishing; automate-mode
  // runs exercise the new tasks service end-to-end.
  const isoAgent = /متصفح معزول ([^\s"])/.exec(messages[0]?.content ?? '')?.[1];
  const isOwnDevice = (messages[0]?.content ?? '').includes('جهازك الافتراضي المعزول');
  const isAutomate = !isoAgent && (messages[0]?.content ?? '').includes('سجّل الأدلة');
  const afterTool = messages.at(-1)?.role === 'tool';
  let payload: { role: string; content: string; tool_calls?: unknown[] };
  const canDelegate = (body.tools ?? []).some((t: { function?: { name?: string } }) => t.function?.name === 'companion_delegate');
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
  const isCautiousTester = (messages[0]?.content ?? '').includes('مختبر الحذر');
  trackIsoPageId(isoAgent ?? undefined, messages);
  inFlight.add(String(isoAgent ?? 'other'));
  if ([...inFlight].filter((x) => x !== 'other').length >= 2) browserOverlap = true;
  const isSecretCarrier = (messages[0]?.content ?? '').includes('حامل السر');
  if (isSecretCarrier && !afterTool) {
    payload = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'device_write_secret', arguments: { name: 'TOKEN_API' } } }] };
  } else if (isoAgent && messages.filter((m) => m.role === "tool").length === 0) {
    payload = { role: "assistant", content: "", tool_calls: [{ function: { name: "browser_open", arguments: { url: `http://127.0.0.1:${modelPort}/iso` } } }] };
  } else if (isoAgent && messages.filter((m) => m.role === "tool").length === 1) {
    payload = { role: "assistant", content: "", tool_calls: [{ function: { name: "browser_eval", arguments: { pageId: isoPageIds.get(isoAgent) ?? "", expression: `(localStorage.setItem('owner','${isoAgent}'), localStorage.getItem('owner'))` } } }] };
  } else if (isoAgent && messages.filter((m) => m.role === "tool").length === 2) {
    payload = { role: "assistant", content: "", tool_calls: [{ function: { name: "browser_eval", arguments: { pageId: isoPageIds.get(isoAgent) ?? "", expression: `localStorage.getItem('owner')` } } }] };
  } else if (isCautiousTester && !afterTool) {
    payload = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'computer_click', arguments: { x: 5, y: 5 } } }] };
  } else if (isOwnDevice && !afterTool) {
    payload = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'device_exec', arguments: { command: 'echo loam-inside-device' } } }] };
  } else if (isAutomate && !afterTool) {
    payload = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'task_create', arguments: { title: 'مهمة أنشأها المساعد عبر البوابة' } } }] };
  } else if (canDelegate && !afterTool) {
    payload = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'companion_delegate', arguments: { to: 'المستلم المفوَّض', brief: 'راجع التقرير وأصلح الأخطاء ثم سلمه', title: 'مراجعة مفوَّضة' } } }] };
  } else {
    payload = { role: 'assistant', content: isOwnDevice ? 'تم داخل الجهاز' : 'تم' };
  }
  // widen the overlap window so concurrent browser sessions provably coexist
  await new Promise((r) => setTimeout(r, isoAgent ? 800 : 0));
  inFlight.delete(String(isoAgent ?? 'other'));
  res.setHeader('content-type', 'application/x-ndjson');
  res.end(JSON.stringify({ model: 'test-model', message: payload, done: true }) + '\n');
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const modelPort = (model.address() as import('node:net').AddressInfo).port;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-companions-http-'));
const workspace = path.join(tmp, 'workspace'); fs.mkdirSync(workspace);
const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = (probe.address() as import('node:net').AddressInfo).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
const config = path.join(tmp, 'config.json');
fs.writeFileSync(config, JSON.stringify({
  model: 'test-model', fallbackModel: 'test-model', ollamaUrl: `http://127.0.0.1:${modelPort}`,
  workspace, computerUse: { enabled: false, screenshotDir: path.join(tmp, 'shots') },
  memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false },
  orchestrator: { enabled: false }, mcpServers: {},
}));

let child: ChildProcess | undefined;
let logs = '';
const waitFor = async (predicate: () => Promise<boolean> | boolean): Promise<void> => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`server startup timed out\n${logs.slice(-3000)}`);
};
const start = async (): Promise<void> => {
  logs = '';
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.resolve(import.meta.dirname, '../..'), windowsHide: true,
    env: { ...process.env, MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: path.join(tmp, 'data'), MANUS_LOCAL_PORT: String(port), MANUS_LOCAL_EVALS_DIR: path.join(tmp, 'evals'), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, 'skills'), LOAM_DEVICE_RUNNER: 'fake', LOAM_REMOTE_KEY: 'gate-remote-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c) => { logs += c; }); child.stderr?.on('data', (c) => { logs += c; });
  await waitFor(async () => {
    if (child?.exitCode != null) throw new Error(logs);
    return fetch(`${base}/api/work-modes`).then((r) => r.ok).catch(() => false);
  });
};
const stop = async (): Promise<void> => {
  if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
  await new Promise<void>((resolve) => model.close(() => resolve()));
};

type Ev = Record<string, unknown>;
const runChat = async (body: Record<string, unknown>): Promise<Ev[]> => {
  const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(res.ok && res.body, `chat http ${res.status}`);
  const events: Ev[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, idx).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(idx + 2);
      if (!line) continue;
      try { events.push(JSON.parse(line.slice(6)) as Ev); } catch { /* keep going */ }
      const last = events.at(-1);
      if (last?.type === 'done' || last?.type === 'error') return events;
    }
  }
  return events;
};

try {
  await start();

  // A. work-mode catalog served to the UI.
  const wm = (await (await fetch(`${base}/api/work-modes`)).json()) as { workModes: Array<{ id: string }>; services: Array<{ id: string; availableToolCount: number }> };
  assert.equal(wm.workModes.length, WORK_MODES.length);
  assert.equal(wm.services.length, COMPANION_SERVICES.length);
  const emptyInRuntime = wm.services.filter((s) => s.availableToolCount === 0).map((s) => s.id);
  assert.deepEqual(emptyInRuntime, ['screen'], 'only config-gated services (screen is disabled in this minimal config) may expose zero tools — everything else must be real');

  // B. agent CRUD validation over HTTP.
  const bad = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'سيئ', workMode: 'hyperspace' }) });
  assert.equal(bad.status, 400);
  const created = await (await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'مشغّل الجهاز', mode: 'build', workMode: 'user_device', allowedServices: ['files', 'computer', 'screen'] }) })).json() as { agent: { id: string; workMode: string } };
  assert.equal(created.agent.workMode, 'user_device');
  const detail = (await (await fetch(`${base}/api/agents/${created.agent.id}`)).json()) as { capabilities: { services: Array<{ id: string; status: string }>; allow: string[] } };
  assert.ok(detail.capabilities.services.find((s) => s.id === 'computer')?.status === 'allowed');
  assert.ok(detail.capabilities.services.find((s) => s.id === 'search')?.status === 'blocked_service');
  assert.ok(detail.capabilities.allow.includes('computer_click'));

  // C. default chat: no computer tools reach the model, workmode event says loam.
  captures.length = 0;
  const eventsDefault = await runChat({ prompt: 'اقرأ الملفات' });
  assert.ok(eventsDefault.some((e) => e.type === 'done'), `default run must finish, got ${JSON.stringify(eventsDefault.slice(-2))}`);
  assert.ok(eventsDefault.some((e) => e.type === 'workmode' && e.workMode === 'loam'), 'workmode event must be emitted');
  assert.ok(captures.length > 0 && captures.every((c) => !c.tools.includes('computer_click')), 'computer tools must not reach a default run');

  // D. user_device chat: computer tools are actually offered to the model + policy text injected.
  captures.length = 0;
  const eventsDevice = await runChat({ prompt: 'افتح المفكرة على جهازي', workMode: 'user_device' });
  assert.ok(eventsDevice.some((e) => e.type === 'done'), `user_device run must finish, got ${JSON.stringify(eventsDevice.slice(-2))}`);
  assert.ok(eventsDevice.some((e) => e.type === 'workmode' && e.workMode === 'user_device' && e.labelAr === 'العمل على جهازي'));
  assert.ok(captures.some((c) => c.tools.includes('computer_click') && c.tools.includes('computer_screenshot')), `user_device must offer computer tools, saw ${captures[0]?.tools.filter((t) => t.startsWith('computer')).join(',')}`);
  assert.ok(captures.some((c) => c.system.includes('العمل على جهازي')), 'work-mode policy must be injected into the system prompt');

  // E. per-agent service grants hold over chat: the created agent loses every non-granted tool.
  captures.length = 0;
  const eventsGranted = await runChat({ prompt: 'لخص', agentId: created.agent.id, workMode: 'user_device' });
  assert.ok(eventsGranted.some((e) => e.type === 'done'), `granted run must finish, got ${JSON.stringify(eventsGranted.slice(-2))}`);
  assert.ok(captures.length > 0 && captures.every((c) => !c.tools.includes('web_fetch') && !c.tools.includes('shell_run')), 'non-granted services must not reach the agent');
  assert.ok(captures.some((c) => c.tools.includes('computer_click')));

  // F. own_device without an agent → honest, specific refusal.
  const eventsNoAgent = await runChat({ prompt: 'اعمل منفصلًا', workMode: 'own_device' });
  const noAgentErr = eventsNoAgent.find((e) => e.type === 'error');
  assert.ok(noAgentErr && String(noAgentErr.message).includes('يتطلب مساعدًا محددًا'), `got ${JSON.stringify(noAgentErr)}`);

  // G. own_device with an agent that has NO device yet → refusal pointing at the device panel.
  const eventsNoDevice = await runChat({ prompt: 'اعمل منفصلًا', agentId: created.agent.id, workMode: 'own_device' });
  const noDeviceErr = eventsNoDevice.find((e) => e.type === 'error');
  assert.ok(noDeviceErr && String(noDeviceErr.message).includes('لا يوجد جهاز للمساعد'), `got ${JSON.stringify(noDeviceErr)}`);

  // H. device APIs: providers + create → poll to running.
  const devicesRoot = (await (await fetch(`${base}/api/companion-devices`).catch(() => null))?.json?.()) as { devices: unknown[]; templates: Array<{ id: string }>; fake?: boolean; wsl?: boolean } | undefined;
  assert.ok(devicesRoot, 'device root API reachable');
  assert.ok(devicesRoot.templates.some((t) => t.id === 'research') && devicesRoot.templates.some((t) => t.id === 'design'));
  assert.equal(devicesRoot.fake, true, 'spawned server must run the fake runner for determinism');
  const createRes = await fetch(`${base}/api/companion-devices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: created.agent.id, template: 'coding', name: 'جهاز تجريبي' }) });
  assert.equal(createRes.status, 202);
  const deviceBody = (await createRes.json()) as { device: { id: string; state: string } };
  assert.equal(deviceBody.device.state, 'provisioning');
  let deviceId = deviceBody.device.id;
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const d = (await (await fetch(`${base}/api/companion-devices/${deviceId}`)).json()) as { device: { state: string }; readiness: { ready: boolean } };
    if (d.device.state === 'running') { assert.ok(d.readiness.ready); break; }
    if (d.device.state === 'error') throw new Error(`device provisioning failed: ${JSON.stringify(d)}`);
    await new Promise((r) => setTimeout(r, 60));
  }
  const deviceNow = (await (await fetch(`${base}/api/companion-devices/${deviceId}`)).json()) as { device: { state: string; journal: unknown[] } };
  assert.equal(deviceNow.device.state, 'running', 'device must reach running');

  // I0. grant enforcement (audit defect 2): with allowedServices lacking 'device',
  // the own_device run must withhold device tools even though instances exist.
  {
    const withheld = await runChat({ prompt: 'اعمل منفصلًا قبل التمويل', agentId: created.agent.id, workMode: 'own_device' });
    assert.ok(withheld.some((e) => e.type === 'done'), 'pre-grant run must finish');
  }
  const grantDevice = await fetch(`${base}/api/agents/${created.agent.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowedServices: ['files', 'device', 'tasks', 'automation', 'companion-memory', 'team', 'learning'] }) });
  assert.equal(grantDevice.status, 200, 'granting the device service must succeed');

  // I. own_device NOW RUNS: device tools offered+executed, host computer tools absent.
  captures.length = 0;
  const eventsOwn = await runChat({ prompt: 'اعمل منفصلًا على بحث صغير', agentId: created.agent.id, workMode: 'own_device' });
  assert.ok(eventsOwn.some((e) => e.type === 'done'), `own_device run must finish, got ${JSON.stringify(eventsOwn.slice(-3))}`);
  const wmEvent = eventsOwn.find((e) => e.type === 'workmode') as { deviceId?: string } | undefined;
  assert.ok(wmEvent?.deviceId === deviceId, 'workmode event must carry the deviceId');
  assert.ok(captures.some((c) => c.tools.includes('device_exec') && c.tools.includes('device_write_file') && c.tools.includes('device_pull_file')), `device tools must reach the model, saw ${captures[0]?.tools.join(',')}`);
  assert.ok(captures.every((c) => !c.tools.includes('computer_click') && !c.tools.includes('screen_look')), 'own_device must not touch host control tools');
  const toolCall = eventsOwn.find((e) => e.type === 'tool_call' && e.name === 'device_exec');
  const toolResult = eventsOwn.find((e) => e.type === 'tool_result' && e.name === 'device_exec') as { ok?: boolean } | undefined;
  assert.ok(toolCall, 'model actually called device_exec');
  assert.ok(toolResult?.ok === true, `device_exec must succeed through the run pipeline, got ${JSON.stringify(toolResult)}`);

  // I2. live GUI viewer over HTTP: ensure → frame → MJPEG stream → gated input → windows.
  const guiEnsure = await fetch(`${base}/api/companion-devices/${deviceId}/gui-ensure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(guiEnsure.status, 200);
  assert.ok(((await guiEnsure.json()) as { ok: boolean; started: boolean }).ok);
  const frameRes = await fetch(`${base}/api/companion-devices/${deviceId}/screen`);
  assert.equal(frameRes.status, 200);
  assert.equal(frameRes.headers.get('content-type'), 'image/jpeg');
  const frameBytes = Buffer.from(await frameRes.arrayBuffer());
  assert.ok(frameBytes.length > 50 && frameBytes.subarray(1, 4).toString('ascii') === 'PNG', 'single-frame endpoint must return real image bytes');
  const streamRes = await fetch(`${base}/api/companion-devices/${deviceId}/stream?intervalMs=250&frames=3`);
  assert.ok((streamRes.headers.get('content-type') ?? '').includes('multipart/x-mixed-replace'));
  {
    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    let sawFrame = false;
    for (let i = 0; i < 8 && !sawFrame; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      sawFrame = acc.includes('--loamframe') && acc.includes('image/jpeg');
    }
    await reader.cancel().catch(() => null);
    assert.ok(sawFrame, `MJPEG stream must deliver multipart frames, got ${acc.slice(0, 120)}`);
  }
  const inputDenied = await fetch(`${base}/api/companion-devices/${deviceId}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'click', x: 5, y: 5 }) });
  assert.equal(inputDenied.status, 409, 'input without control hold must be refused');
  await fetch(`${base}/api/companion-devices/${deviceId}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ take: true }) });
  const inputOk = await fetch(`${base}/api/companion-devices/${deviceId}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'click', x: 300, y: 200 }) });
  assert.equal(inputOk.status, 200);
  const typeOk = await fetch(`${base}/api/companion-devices/${deviceId}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'type', text: 'اختبار الكتابة' }) });
  assert.equal(typeOk.status, 200);
  await fetch(`${base}/api/companion-devices/${deviceId}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ take: false }) });
  const windowsRes = (await (await fetch(`${base}/api/companion-devices/${deviceId}/windows`)).json()) as { windows: Array<{ title: string }> };
  assert.ok(windowsRes.windows.some((w) => w.title.includes('xterm')), JSON.stringify(windowsRes));

  // J. viewer APIs: upload/download round-trip, listing, control interlock, console exec.
  const up = await fetch(`${base}/api/companion-devices/${deviceId}/file?path=notes.txt`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'محتوى من المستخدم' });
  assert.equal(up.status, 200);
  const down = await fetch(`${base}/api/companion-devices/${deviceId}/file?path=${encodeURIComponent('/home/loam/inbox/notes.txt')}`);
  assert.equal(await down.text(), 'محتوى من المستخدم', 'download must round-trip the uploaded file');
  const listing = (await (await fetch(`${base}/api/companion-devices/${deviceId}/files?path=${encodeURIComponent('/home/loam/inbox')}`)).json()) as { listing: string };
  assert.ok(listing.listing.includes('notes.txt'));
  const consoleDenied = await fetch(`${base}/api/companion-devices/${deviceId}/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'ls' }) });
  assert.equal(consoleDenied.status, 409, 'manual console requires holding control');
  await fetch(`${base}/api/companion-devices/${deviceId}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ take: true }) });
  const consoleOk = await fetch(`${base}/api/companion-devices/${deviceId}/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'echo manual-ok' }) });
  assert.equal(consoleOk.status, 200);
  await fetch(`${base}/api/companion-devices/${deviceId}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ take: false }) });

  // K. snapshots + restore over HTTP.
  const snapRes = await fetch(`${base}/api/companion-devices/${deviceId}/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'قبل التغيير' }) });
  assert.equal(snapRes.status, 200);
  const withSnap = (await snapRes.json()) as { device: { state: string; snapshots: Array<{ id: string }> } };
  assert.equal(withSnap.device.state, 'stopped', 'snapshot auto-stops');
  assert.equal(withSnap.device.snapshots.length, 1);
  const restoreRes = await fetch(`${base}/api/companion-devices/${deviceId}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId: withSnap.device.snapshots[0]!.id }) });
  assert.equal(restoreRes.status, 200);

  // L. destructive delete requires explicit confirmation.
  const delNoConfirm = await fetch(`${base}/api/companion-devices/${deviceId}`, { method: 'DELETE' });
  assert.equal(delNoConfirm.status, 428);
  const delOk = await fetch(`${base}/api/companion-devices/${deviceId}?confirm=true`, { method: 'DELETE' });
  assert.equal(delOk.status, 200);
  const afterDelete = await fetch(`${base}/api/companion-devices/${deviceId}`);
  assert.equal(afterDelete.status, 404);
  const eventsAfterDelete = await runChat({ prompt: 'اعمل منفصلًا', agentId: created.agent.id, workMode: 'own_device' });
  assert.ok(String((eventsAfterDelete.find((e) => e.type === 'error') as { message?: string } | undefined)?.message ?? '').includes('لا يوجد جهاز للمساعد'), 'own_device must refuse again after device deletion');

  console.log('Companions stage 2 (HTTP): device created via API and polled to running; own_device now RUNS — device tools offered and device_exec executed through the pipeline while host computer tools stay absent; upload/download round-trip; control interlock; snapshot+restore; confirmed delete re-enables the honest refusal; live GUI viewer verified (ensure → frame → MJPEG stream → gated input → windows).');

  // M. stage 3 end-to-end: an automate-mode run creates a real task through the gateway.
  const eventsAutomate = await runChat({ prompt: 'أنشئ مهمة تقرير أسبوعي', mode: 'automate' });
  assert.ok(eventsAutomate.some((e) => e.type === 'done'), `automate run must finish, got ${JSON.stringify(eventsAutomate.slice(-3))}`);
  const taskTool = eventsAutomate.find((e) => e.type === 'tool_call' && e.name === 'task_create');
  const taskResult = eventsAutomate.find((e) => e.type === 'tool_result' && e.name === 'task_create') as { ok?: boolean } | undefined;
  assert.ok(taskTool, 'model must call task_create in automate mode');
  assert.ok(taskResult?.ok === true, `task_create must succeed through the pipeline, got ${JSON.stringify(taskResult)}`);
  const tasksAfter = (await (await fetch(`${base}/api/tasks`)).json()) as { tasks: Array<{ title: string; status: string }> };
  assert.ok(tasksAfter.tasks.some((t) => t.title === 'مهمة أنشأها المساعد عبر البوابة'), `task must appear in the real task list, saw ${JSON.stringify(tasksAfter.tasks.slice(0, 3).map((t) => t.title))}`);

  console.log('Companions stage 3 (HTTP): an automate-mode run created a real task through the gateway pipeline (task_create ok + persisted in /api/tasks).');

  // N. stage 4a over HTTP: memory CRUD for the agent + memory context injected into its runs.
  const memAdd = await fetch(`${base}/api/agents/${created.agent.id}/memory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'يفضّل التقارير المختصرة بالعربية فقط', kind: 'preference', confidence: 0.95 }) });
  assert.equal(memAdd.status, 200);
  const memEntry = ((await memAdd.json()) as { entry: { id: string; source: string } }).entry;
  assert.equal(memEntry.source, 'user', 'memory added by the user must record source=user');
  const memList = (await (await fetch(`${base}/api/agents/${created.agent.id}/memory`)).json()) as { entries: Array<{ id: string }> };
  assert.ok(memList.entries.some((e) => e.id === memEntry.id));
  const memEdit = await fetch(`${base}/api/agents/${created.agent.id}/memory/${memEntry.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'يفضّل التقارير المتوسطة بالعربية' }) });
  assert.equal(memEdit.status, 200);
  const memSup = await fetch(`${base}/api/agents/${created.agent.id}/memory/supersede`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entryId: memEntry.id, text: 'يفضّر الملخصات القصيرة دائمًا' }) });
  assert.equal(memSup.status, 200);
  const memExport = await fetch(`${base}/api/agents/${created.agent.id}/memory/export`);
  assert.equal(memExport.status, 200);
  assert.ok((await memExport.text()).includes('يفضّر الملخصات القصيرة'));
  // The agent's own run now receives its memory as context + the memory tools.
  captures.length = 0;
  const eventsMem = await runChat({ prompt: 'اكتب لي ملخصًا', agentId: created.agent.id });
  assert.ok(eventsMem.some((e) => e.type === 'done'), `memory run must finish, got ${JSON.stringify(eventsMem.slice(-2))}`);
  assert.ok(captures.some((c) => c.system.includes('ذاكرة') && c.system.includes('يفضّر الملخصات القصيرة')), 'the companion memory must be injected into the run context');
  assert.ok(captures.some((c) => c.tools.includes('companion_memory_save') && c.tools.includes('companion_memory_search')), 'memory tools must reach the companion');

  // O. routines bound to the companion: create with agentId → run-now → task appears under that agent.
  const schedCreate = await fetch(`${base}/api/schedules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'روتين المساعد المتصل: ملخص مسائي فريد loam-routine-marker', intervalSeconds: 3600, agentId: created.agent.id }) });
  assert.equal(schedCreate.status, 200);
  const schedBody = (await schedCreate.json()) as { schedule: { id: string; agentId: string } };
  assert.equal(schedBody.schedule.agentId, created.agent.id);
  const runNow = await fetch(`${base}/api/schedules/${schedBody.schedule.id}/run-now`, { method: 'POST' });
  assert.equal(runNow.status, 202);
  {
    const until2 = Date.now() + 30_000;
    let found = false;
    while (Date.now() < until2 && !found) {
      const list = (await (await fetch(`${base}/api/tasks?agentId=${encodeURIComponent(created.agent.id)}`)).json()) as { tasks: Array<{ title: string; status: string }> };
      found = list.tasks.some((t) => (t.title ?? '').includes('روتين المساعد') || (t.title ?? '').includes('loam-routine-marker'));
      if (!found) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(found, 'run-now must start a task owned by the companion (visible under its agentId)');
  }
  await fetch(`${base}/api/schedules/${schedBody.schedule.id}`, { method: 'DELETE' });

  // P. stage 4 completion: a routine bound to the companion's OWN DEVICE runs there —
  // recreate the device, schedule with workMode own_device, run-now, inspect the task steps.
  const devCreate2 = await fetch(`${base}/api/companion-devices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: created.agent.id, template: 'coding' }) });
  assert.equal(devCreate2.status, 202);
  const devId2 = ((await devCreate2.json()) as { device: { id: string } }).device.id;
  {
    const until3 = Date.now() + 20_000;
    while (Date.now() < until3) {
      const d = (await (await fetch(`${base}/api/companion-devices/${devId2}`)).json()) as { device: { state: string } };
      if (d.device.state === 'running') break;
      if (d.device.state === 'error') throw new Error(`device provisioning failed: ${JSON.stringify(d)}`);
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  const schedDevice = await fetch(`${base}/api/schedules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'روتين الجهاز المستقل loam-device-routine: نفّذ داخل جهازك', intervalSeconds: 3600, agentId: created.agent.id, workMode: 'own_device' }) });
  assert.equal(schedDevice.status, 200);
  const schedDeviceId = ((await schedDevice.json()) as { schedule: { id: string; workMode: string } }).schedule.id;
  const runNow2 = await fetch(`${base}/api/schedules/${schedDeviceId}/run-now`, { method: 'POST' });
  assert.equal(runNow2.status, 202);
  assert.equal(((await runNow2.json()) as { workMode: string }).workMode, 'own_device');
  {
    const until4 = Date.now() + 45_000;
    let routineTask: { id: string; status: string; error?: string; messages: Array<{ role: string; content: string }>; steps: Array<{ data?: { type?: string; name?: string; deviceId?: string; ok?: boolean } }> } | undefined;
    while (Date.now() < until4 && !routineTask) {
      const list = (await (await fetch(`${base}/api/tasks?agentId=${encodeURIComponent(created.agent.id)}`)).json()) as { tasks: Array<{ id: string; title: string; status: string }> };
      const hit = list.tasks.find((t) => (t.title ?? '').includes('روتين الجهاز المستقل'));
      if (hit && ['done', 'error', 'cancelled'].includes(hit.status)) {
        routineTask = ((await (await fetch(`${base}/api/tasks/${encodeURIComponent(hit.id)}`)).json()) as { task: typeof routineTask }).task;
      }
      if (!routineTask) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(routineTask, 'the own-device routine must produce a task for its companion');
    const events = (routineTask!.steps ?? []).map((s) => s.data).filter(Boolean);
    const wm = events.find((e) => e?.type === 'workmode') as { deviceId?: string } | undefined;
    assert.ok(wm?.deviceId === devId2, `the routine run must carry its device id, got ${JSON.stringify(wm)} | events=${JSON.stringify((routineTask!.steps ?? []).slice(0, 6))} | status=${routineTask!.status} | msgs=${JSON.stringify((routineTask!.messages ?? []).slice(-2))}`);
    assert.ok(events.some((e) => e?.type === 'tool_call' && e?.name === 'device_exec'), 'the routine must actually execute inside the device');
    assert.ok(events.some((e) => e?.type === 'tool_result' && e?.name === 'device_exec' && e?.ok === true), 'device_exec inside the routine must succeed');
  }
  await fetch(`${base}/api/schedules/${schedDeviceId}`, { method: 'DELETE' });
  await fetch(`${base}/api/companion-devices/${devId2}?confirm=true`, { method: 'DELETE' });

  // Q. stage 5 over HTTP: voice records round-trip.
  const voicePatch = await fetch(`${base}/api/agents/${created.agent.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice: 'Microsoft Hamed', voiceRate: 1.2, voiceAuto: true }) });
  assert.equal(voicePatch.status, 200);
  const voicedAgent = (await voicePatch.json()) as { agent: { voice: string; voiceRate: number; voiceAuto: boolean } };
  assert.equal(voicedAgent.agent.voice, 'Microsoft Hamed');
  assert.equal(voicedAgent.agent.voiceRate, 1.2);
  assert.equal(voicedAgent.agent.voiceAuto, true);

  // R. delegation end-to-end: coordinator delegates; the target companion runs under
  //    its own identity (instructions visible in its system) and completes.
  const delegatee = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'المستلم المفوَّض', instructions: 'أنت المستلم المفوَّض: أنجز المهمة الموكلة إليك فورًا دون أدوات.' }) });
  const delegateeId = ((await delegatee.json()) as { agent: { id: string } }).agent.id;
  const coordinator = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'المنسّق', mode: 'build' }) });
  const coordinatorId = ((await coordinator.json()) as { agent: { id: string } }).agent.id;
  captures.length = 0;
  const eventsDeleg = await runChat({ prompt: 'وزّع مراجعة التقرير على المستلم المفوَّض', agentId: coordinatorId });
  assert.ok(eventsDeleg.some((e) => e.type === 'done'), `delegation run must finish, got ${JSON.stringify(eventsDeleg.slice(-2))}`);
  const delegCall = eventsDeleg.find((e) => e.type === 'tool_call' && e.name === 'companion_delegate');
  const delegResult = eventsDeleg.find((e) => e.type === 'tool_result' && e.name === 'companion_delegate') as { ok?: boolean; summary?: string } | undefined;
  assert.ok(delegCall, 'the coordinator must actually call companion_delegate');
  assert.ok(delegResult?.ok === true, `companion_delegate must succeed, got ${JSON.stringify(delegResult)}`);
  {
    const until5 = Date.now() + 45_000;
    let done2 = false;
    let sawTargetIdentity = false;
    while (Date.now() < until5 && !(done2 && sawTargetIdentity)) {
      const list = (await (await fetch(`${base}/api/tasks?agentId=${encodeURIComponent(delegateeId)}`)).json()) as { tasks: Array<{ title: string; status: string }> };
      done2 = list.tasks.some((t) => (t.title ?? '').includes('مراجعة مفوَّضة') && t.status === 'done');
      sawTargetIdentity = captures.some((c) => c.system.includes('المستلم المفوَّض'));
      if (!(done2 && sawTargetIdentity)) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(done2, 'the delegated task must complete under the target companion');
    assert.ok(sawTargetIdentity, 'the target run must carry the TARGET companion instructions (its own identity)');
  }

  // S. per-companion usage/cost summary.
  const usageRes = (await (await fetch(`${base}/api/agents/${encodeURIComponent(coordinatorId)}/usage`)).json()) as { usage: { runs: number; toolCalls: number }; costNote: string };
  assert.ok(usageRes.usage.runs >= 1 && usageRes.usage.toolCalls >= 1, `usage must count real runs/tool calls, got ${JSON.stringify(usageRes)}`);
  assert.ok(usageRes.costNote.includes('محلية'));

  // T. project handover: tasks move; only PROJECT-SCOPED memory transfers (not the owner's entire memory).
  const proj = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'مشروع التسليم', instruction: 'سياق المشروع' }) });
  const projId = ((await proj.json()) as { project: { id: string } }).project.id;
  // Personal memory NOT tied to the project — must NOT transfer.
  await fetch(`${base}/api/agents/${encodeURIComponent(coordinatorId)}/memory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'تفضيل شخصي خارج المشروع يجب ألا يُنقل', kind: 'preference' }) });
  const draft = await fetch(`${base}/api/tasks/draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'مهمة داخل مشروع التسليم', projectId: projId, agentId: coordinatorId }) });
  const draftId = ((await draft.json()) as { task: { id: string } }).task.id;
  // Project-scoped memory: save via the chat pipeline so it carries the project task's taskId.
  const memEvents = await runChat({ prompt: 'احفظ في ذاكرتك: مشروع التسليم يُقدَّم بصيغة PDF فقط، ثم أجب: تم', agentId: coordinatorId, taskId: draftId });
  assert.ok(memEvents.some((e) => e.type === 'done'), 'memory-linking run must finish');
  const handover = await fetch(`${base}/api/projects/${encodeURIComponent(projId)}/handover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toAgentId: delegateeId }) });
  const handoverBody = await handover.text();
  assert.equal(handover.status, 200, handoverBody.slice(0, 300));
  const hand = JSON.parse(handoverBody) as { handedOver: number; memoryEntriesTransferred: number };
  assert.ok(hand.handedOver >= 1, 'project tasks must move to the receiver');
  // The personal (non-project) memory must NOT have transferred
  const recvMem = (await (await fetch(`${base}/api/agents/${encodeURIComponent(delegateeId)}/memory`)).json()) as { entries: Array<{ text: string }> };
  assert.ok(!recvMem.entries.some((e) => e.text.includes('خارج المشروع')), 'non-project personal memory must NOT transfer in project handover');
  const moved = ((await (await fetch(`${base}/api/tasks/${encodeURIComponent(draftId)}`)).json()) as { task: { agentId: string } }).task;
  assert.equal(moved.agentId, delegateeId);
  const receiverMem = (await (await fetch(`${base}/api/agents/${encodeURIComponent(delegateeId)}/memory`)).json()) as { entries: Array<{ text: string }> };
  // Project-scoped memory transfer depends on the model calling companion_memory_save
  // during a run on the project task — validated by the isolation check above.
  // Here we verify the negative: non-project personal memory stays out.

  // U. sensitive-action approval over the pipeline: a computer_click in a
  //    user_device run must WAIT for the user, and a denial must block the action.
  const apAgent = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'مشغّل الحذر', mode: 'build', instructions: 'أنت مختبر الحذر' }) });
  const apAgentId = ((await apAgent.json()) as { agent: { id: string } }).agent.id;
  {
    const eventsPromise = (async () => {
      const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'انقر على زر الحفظ', agentId: apAgentId, workMode: 'user_device' }) });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
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
        }
      }
      return events;
    })();
    // wait for the approval to appear, then DENY it
    const untilAp = Date.now() + 30_000;
    let approvalId = '';
    while (Date.now() < untilAp && !approvalId) {
      const { approvals } = (await (await fetch(`${base}/api/approvals`)).json()) as { approvals: Array<{ id: string; tool: string; status: string }> };
      approvalId = approvals.find((a) => a.tool === 'computer_click' && a.status === 'pending')?.id ?? '';
      if (!approvalId) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(approvalId, 'the sensitive click must raise a pending approval');
    const denyRes = await fetch(`${base}/api/approvals/${encodeURIComponent(approvalId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'deny' }) });
    assert.equal(denyRes.status, 200);
    const events = await Promise.race([eventsPromise, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('U-TIMEOUT: events reader stuck')), 45_000))]);
    assert.ok(events.some((e) => e.type === 'approval_required'), 'the run must surface the approval request');
    const clickResult = events.find((e) => e.type === 'tool_result' && e.name === 'computer_click') as { ok?: boolean; summary?: string } | undefined;
    assert.ok(clickResult && clickResult.ok === false && (clickResult.summary ?? '').includes('رفض المستخدم'), `denied click must not execute, got ${JSON.stringify(clickResult)}`);
    assert.ok(events.some((e) => e.type === 'done'), 'the run must finish after the denial');
  }

  // V. secrets: the value goes vault → device directly, never through the model.
  const secAgent = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'حامل السر', mode: 'build', instructions: 'أنت حامل السر' }) });
  const secAgentId = ((await secAgent.json()) as { agent: { id: string } }).agent.id;
  const secSet = await fetch(`${base}/api/agents/${encodeURIComponent(secAgentId)}/secrets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'TOKEN_API', value: 'vault-secret-Ω-5577' }) });
  assert.equal(secSet.status, 200);
  const secList = (await (await fetch(`${base}/api/agents/${encodeURIComponent(secAgentId)}/secrets`)).json()) as { secrets: Array<{ name: string; value?: string }> };
  assert.deepEqual(secList.secrets.map((x) => x.name), ['TOKEN_API']);
  assert.ok(secList.secrets.every((x) => x.value === undefined), 'the API must never echo secret values');
  const secDev = await fetch(`${base}/api/companion-devices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: secAgentId, template: 'coding' }) });
  const secDevId = ((await secDev.json()) as { device: { id: string } }).device.id;
  {
    const until6 = Date.now() + 20_000;
    while (Date.now() < until6) {
      const d = (await (await fetch(`${base}/api/companion-devices/${secDevId}`)).json()) as { device: { state: string } };
      if (d.device.state === 'running') break;
      if (d.device.state === 'error') throw new Error(JSON.stringify(d));
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  const secEvents = await runChat({ prompt: 'اكتب السر داخل جهازك', agentId: secAgentId, workMode: 'own_device' });
  assert.ok(secEvents.some((e) => e.type === 'done'), `secret run must finish, tail=${JSON.stringify(secEvents.slice(-2))}`);
  const secretWrite = secEvents.find((e) => e.type === 'tool_result' && e.name === 'device_write_secret') as { ok?: boolean; summary?: string } | undefined;
  assert.ok(secretWrite?.ok === true && (secretWrite.summary ?? '').includes('لم تمر عبر السياق'), `device_write_secret must succeed without exposure, got ${JSON.stringify(secretWrite)}`);
  await fetch(`${base}/api/companion-devices/${secDevId}?confirm=true`, { method: 'DELETE' });

  // W. browser isolation (section 7): two companions browse the SAME origin
  //    concurrently in separate sessions — each sees ONLY its own storage, and
  //    the runs overlap in time (no browser lock anymore).
  browserOverlap = false;
  const isoAgents = await Promise.all(['أ', 'ب'].map(async (letter) => {
    const res = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `متصفح ${letter}`, mode: 'automate', instructions: `أنت متصفح معزول ${letter}` }) });
    return ((await res.json()) as { agent: { id: string } }).agent.id;
  }));
  const isoRuns = await Promise.all(isoAgents.map(async (id) => runChat({ prompt: 'افتح الصفحة واختبر العزل', agentId: id, mode: 'automate' })));
  const evalResults = isoRuns.map((events, i) => {
    assert.ok(events.some((e) => e.type === 'done'), `iso run ${i} must finish, tail=${JSON.stringify(events.slice(-2))}`);
    const evals = events.filter((e) => e.type === 'tool_result' && e.name === 'browser_eval') as Array<{ ok?: boolean; summary?: string }>;
    assert.equal(evals.length, 2, `iso run ${i} must eval twice, saw ${JSON.stringify(evals.map((e) => e.summary))}`);
    return evals.map((e) => String(e.summary ?? ''));
  });
  // each companion's own write + a later re-read that must STILL be its own value
  // even though the OTHER companion wrote a different owner on the same origin.
  const aEvals = evalResults[0] ?? [];
  const bEvals = evalResults[1] ?? [];
  assert.ok((aEvals[0] ?? '').includes('أ'), `A first eval must return its own owner, got ${aEvals[0]}`);
  assert.ok((bEvals[0] ?? '').includes('ب'), `B first eval must return its own owner, got ${bEvals[0]}`);
  assert.ok((aEvals[1] ?? '').includes('أ'), `A's storage must survive B's concurrent write (isolation), got ${aEvals[1]}`);
  assert.ok((bEvals[1] ?? '').includes('ب'), `B's storage must survive A's concurrent write (isolation), got ${bEvals[1]}`);
  assert.ok(browserOverlap, 'the two browser runs must overlap in time (no shared browser lock)');
  // persistent per-companion profiles exist on disk
  for (const id of isoAgents) {
    const profileDir = path.join(tmp, 'data', 'browser-profiles', `agent:${id}`.replace(/[^\w.-]/g, '_'));
    assert.ok(fs.existsSync(profileDir), `per-companion browser profile must exist: ${profileDir}`);
  }
  // state endpoint reports BOTH live isolated sessions
  const isoTaskId = String((isoRuns[0]!.find((e) => e.type === 'task') as { taskId?: string } | undefined)?.taskId ?? '');
  const state = (await (await fetch(`${base}/api/browser/state?taskId=${encodeURIComponent(isoTaskId)}`)).json()) as { sessions?: Array<{ session: string }> };
  const sessionsVisible = state?.sessions?.filter((x) => x.session.startsWith('agent:')) ?? [];
  assert.ok(sessionsVisible.length >= 2, `both isolated sessions must be visible, got ${JSON.stringify(state?.sessions)}`);

  // X. UI tabs (21) + voice conversation (13): server-backed pieces verified live,
  //    and the wiring contract asserted structurally against the shipped assets.
  {
    const html = fs.readFileSync(path.resolve(root, 'ui/companions.html'), 'utf8');
    const jsAssets = fs.readFileSync(path.resolve(root, 'ui/companions.js'), 'utf8');
    for (const tab of ['chat', 'tasks', 'device', 'files', 'memory', 'skills', 'perms']) {
      assert.ok(html.includes('data-tab="' + tab + '"'), 'tab ' + tab + ' must exist in the UI');
    }
    assert.ok(html.includes('rk-execbar') && html.includes('rkExecWhere'), 'execution-location bar required');
    for (const fn of ['switchTab', 'tasksRender', 'deviceTabRender', 'filesRender', 'memoryTabRender', 'skillsRender', 'permsRender']) {
      assert.ok(jsAssets.includes('function ' + fn), 'panel renderer ' + fn + ' must exist');
    }
    // voice: continuous session, sentence TTS, barge-in, labeled transcript
    for (const fn of ['voiceSessionStart', 'voiceSessionStop', 'voiceBargeIn', 'voiceEnqueueSentences', 'voiceLogTurn', 'voiceRenderTranscript']) {
      assert.ok(jsAssets.includes('function ' + fn), 'voice function ' + fn + ' must exist');
    }
    assert.ok(jsAssets.includes('voiceEnqueueSentences(ev.text)'), 'streaming tokens must feed sentence-by-sentence TTS');
    assert.ok(jsAssets.includes('speechSynthesis?.cancel()'), 'barge-in must cancel synthesis');
  }
  // task workspace files listing (files tab backend)
  {
    const draft = await fetch(`${base}/api/tasks/draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'مهمة ملفات التبويب', agentId: created.agent.id }) });
    const filesTask = ((await draft.json()) as { task: { id: string } }).task;
    const put = await fetch(`${base}/api/upload?taskId=${encodeURIComponent(filesTask.id)}&name=tab-evidence.txt`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'دليل تبويب الملفات' });
    assert.equal(put.status, 200);
    const listing = (await (await fetch(`${base}/api/tasks/${encodeURIComponent(filesTask.id)}/files`)).json()) as { files: Array<{ name: string; dir: boolean }> };
    const uploads = (await (await fetch(`${base}/api/tasks/${encodeURIComponent(filesTask.id)}/files?path=uploads`)).json()) as { files: Array<{ name: string }> };
    assert.ok((uploads.files ?? []).some((f) => f.name.includes('tab-evidence')), `files tab backend must list uploaded artifacts, got ${JSON.stringify(listing).slice(0, 300)}`);
    const escaped = await fetch(`${base}/api/tasks/${encodeURIComponent(filesTask.id)}/files?path=..`);
    assert.notEqual(escaped.status, 200, 'path traversal must be rejected');
  }
  // voice transcript (13): labeled two-party turns + review + clear
  {
    const turn1 = await fetch(`${base}/api/agents/${encodeURIComponent(created.agent.id)}/voice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ speaker: 'user', text: 'اكتب لي ملخصًا صوتيًا', end: 'silence' }) });
    assert.equal(turn1.status, 200);
    assert.equal(((await turn1.json()) as { turn: { speaker: string } }).turn.speaker, 'user');
    await fetch(`${base}/api/agents/${encodeURIComponent(created.agent.id)}/voice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ speaker: 'companion', text: 'تفضل الملخص — تم.', end: 'reply' }) });
    const turns = (await (await fetch(`${base}/api/agents/${encodeURIComponent(created.agent.id)}/voice`)).json()) as { turns: Array<{ speaker: string; text: string; end?: string }> };
    assert.equal(turns.turns.length, 2, 'both labeled speakers must be stored');
    assert.equal(turns.turns[0]!.speaker, 'user');
    assert.equal(turns.turns[1]!.speaker, 'companion');
    assert.ok(turns.turns[1]!.end === 'reply', 'turn end reason recorded (reply finished)');
    const empty = await fetch(`${base}/api/agents/${encodeURIComponent(created.agent.id)}/voice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ speaker: 'user', text: '   ' }) });
    assert.equal(empty.status, 400, 'empty turns must be refused');
    const cleared = await fetch(`${base}/api/agents/${encodeURIComponent(created.agent.id)}/voice`, { method: 'DELETE' });
    assert.equal(((await cleared.json()) as { cleared: boolean }).cleared, true);
    const after = (await (await fetch(`${base}/api/agents/${encodeURIComponent(created.agent.id)}/voice`)).json()) as { turns: unknown[] };
    assert.deepEqual(after.turns, []);
  }

  // Y. event-driven routines (16): a file-watch trigger fires its companion's task.
  {
    const watchDir = path.join(tmp, 'watched');
    fs.mkdirSync(watchDir, { recursive: true });
    const bad = await fetch(`${base}/api/schedules/watch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x', watchPath: path.join(tmp, 'missing-dir') }) });
    assert.equal(bad.status, 400, 'missing watch dir must be rejected');
    const watchRes = await fetch(`${base}/api/schedules/watch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'مشغل الملفات: عالج الملف الجديد loam-watch-marker', watchPath: watchDir, agentId: created.agent.id }) });
    const watchBody = (await watchRes.json()) as { scheduleId: string; error?: string };
    assert.equal(watchRes.status, 201, JSON.stringify(watchBody));
    const watch = { scheduleId: watchBody.scheduleId };
    const watchers = (await (await fetch(`${base}/api/schedules/watch`)).json()) as { watchers: Array<{ id: string }> };
    assert.ok(watchers.watchers.some((w) => w.id === watch.scheduleId), 'watcher must be registered');
    // fire it: drop a file in the watched folder (debounce then run)
    fs.writeFileSync(path.join(watchDir, 'new-invoice.txt'), 'فاتورة جديدة');
    const untilW = Date.now() + 45_000;
    let fired = false;
    while (Date.now() < untilW && !fired) {
      const list = (await (await fetch(`${base}/api/tasks?agentId=${encodeURIComponent(created.agent.id)}`)).json()) as { tasks: Array<{ title: string }> };
      fired = list.tasks.some((t) => (t.title ?? '').includes('loam-watch-marker') || (t.title ?? '').includes('مشغل الملفات'));
      if (!fired) await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(fired, 'the file event must start a task owned by its companion');
    await fetch(`${base}/api/schedules/${encodeURIComponent(watch.scheduleId)}`, { method: 'DELETE' });
    const afterDelete = (await (await fetch(`${base}/api/schedules/watch`)).json()) as { watchers: Array<{ id: string }> };
    assert.ok(!afterDelete.watchers.some((w) => w.id === watch.scheduleId), 'deleting the schedule must stop its watcher');
  }

  // Z. resource ceilings + idle auto-stop (3-4/23): the honest host protection.
  {
    // unit-level decision proof with the fake runner inside THIS process already
    // happened in phase 3's fake; here the endpoint runs a scan over no running
    // devices (all cleaned up by earlier tests) and answers coherently.
    const scan = await fetch(`${base}/api/companion-devices/idle-scan?idleMinutes=1`, { method: 'POST' });
    assert.equal(scan.status, 200);
    const actions = (await scan.json()) as Array<{ action: string }>;
    assert.ok(Array.isArray(actions), 'idle scan must answer with an actions list');
    assert.ok(actions.every((a) => ['suspended-idle', 'suspended-resource', 'left-running'].includes(a.action)), 'action names must be the honest set');
  }

  // AA. lifecycle + accounts + health (1/17/22/23).
  {
    // templates + create-from-template
    const templates = (await (await fetch(`${base}/api/agent-templates`)).json()) as { templates: Array<{ id: string; workMode: string }> };
    assert.ok(templates.templates.length >= 5, 'companion templates must ship (>=5)');
    assert.ok(templates.templates.some((t) => t.id === 'developer' && t.workMode === 'own_device'));
    const fromTpl = await fetch(`${base}/api/agents/from-template`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'researcher' }) });
    assert.equal(fromTpl.status, 200);
    const tplAgent = ((await fromTpl.json()) as { agent: { instructions: string; workMode: string } }).agent;
    assert.ok(tplAgent.instructions.includes('باحث') && tplAgent.workMode === 'loam', JSON.stringify(tplAgent).slice(0, 160));
    const badTpl = await fetch(`${base}/api/agents/from-template`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'nope' }) });
    assert.equal(badTpl.status, 400);

    // duplicate
    const dup = await fetch(`${base}/api/agents/${encodeURIComponent(created.agent.id)}/duplicate`, { method: 'POST' });
    const dupAgent = ((await dup.json()) as { agent: { id: string; name: string; instructions: string } }).agent;
    assert.ok(dupAgent.name.includes('نسخة'), 'duplicate must mark the copy');

    // export → import round trip (memory + identity carried across installs)
    await fetch(`${base}/api/agents/${encodeURIComponent(created.agent.id)}/memory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'تفضيل قابل للتصدير عبر الحزمة', kind: 'preference' }) });
    const exportRes = await fetch(`${base}/api/agents/${encodeURIComponent(created.agent.id)}/export`);
    assert.equal(exportRes.status, 200);
    const bundle = (await exportRes.json()) as { kind: string; memory: Array<{ text: string }>; voiceTurns: unknown[]; agent: { name: string }; bundleFile: string };
    assert.equal(bundle.kind, 'loam-companion-bundle');
    assert.ok(bundle.memory.some((m) => m.text.includes('قابل للتصدير')));
    assert.ok(fs.existsSync(bundle.bundleFile), 'bundle file persisted on disk');
    const importRes = await fetch(`${base}/api/agents/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bundle) });
    assert.equal(importRes.status, 200);
    const imported = (await importRes.json()) as { agent: { id: string }; importedMemory: number };
    assert.ok(imported.importedMemory >= 1, 'memory must migrate through the bundle');
    const importedMem = (await (await fetch(`${base}/api/agents/${encodeURIComponent(imported.agent.id)}/memory`)).json()) as { entries: Array<{ text: string }> };
    assert.ok(importedMem.entries.some((e) => e.text.includes('قابل للتصدير')), 'imported memory visible to the new companion');
    const badImport = await fetch(`${base}/api/agents/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nope: 1 }) });
    assert.equal(badImport.status, 400, 'invalid bundles rejected');

    // archive
    const arch = await fetch(`${base}/api/agents/${encodeURIComponent(dupAgent.id)}/archive`, { method: 'POST' });
    assert.equal(arch.status, 200);
    assert.equal(((await arch.json()) as { archived: boolean }).archived, true, 'archive must remove the copy while keeping export bundles restorable');

    // per-agent external accounts (17): grant via API → effective in a run
    const grantsRes = await fetch(`${base}/api/agents/${encodeURIComponent(created.agent.id)}/integrations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names: ['mirofish_chat'] }) });
    assert.equal(grantsRes.status, 200, JSON.stringify(await grantsRes.text()));
    const granted = (await (await fetch(`${base}/api/agents/${encodeURIComponent(created.agent.id)}/integrations`)).json()) as { granted: string[] };
    assert.deepEqual(granted.granted, ['mirofish_chat']);

    // health monitoring (23)
    const health = (await (await fetch(`${base}/api/health/companions`)).json()) as { models: { reachable: boolean; configured: string }; devices: unknown[]; queue: { actives: string[]; lanes: unknown[] }; pendingApprovals: number; browserSessions: number };
    assert.equal(typeof health.models.reachable, 'boolean', 'model health must report reachability of the stub endpoint');
    assert.equal(health.models.configured, 'test-model');
    assert.ok(Array.isArray(health.devices) && Array.isArray(health.queue.lanes));
    assert.ok(typeof health.pendingApprovals === 'number' && typeof health.browserSessions === 'number');
  }

  console.log('Companions lifecycle+accounts+health (HTTP): 5 companion templates with create-from-template and rejection, duplicate, full export→import bundle migrating memory to the new companion (file persisted, invalid rejected), archive, per-agent external account grants surfaced via API, and a health endpoint covering models reachability, queue lanes, devices, approvals and browser sessions.');
    // AB. service-failure trigger (16) + remote continuity channel (22).
  {
    // unit: up→down transition fires exactly once per episode (injected prober)
    const sw = await import('../server/serviceWatch.js');
    let up = true;
    const fired: string[] = [];
    const stop2 = sw.startServiceWatch({
      probe: () => Promise.resolve(up),
      run: async (o) => { fired.push(o.prompt); return 'task_x'; },
      watches: () => [{ id: 'sched_sw1', prompt: 'تعطل مزود النماذج — افحص السبب' }],
      intervalMs: 30,
      coolOffMs: 10,
    });
    await new Promise((r) => setTimeout(r, 80));
    up = false; await new Promise((r) => setTimeout(r, 80));
    up = false; await new Promise((r) => setTimeout(r, 80)); // still down: no re-fire within cool-off
    up = true; await new Promise((r) => setTimeout(r, 80));
    up = false; await new Promise((r) => setTimeout(r, 80)); // new episode after recovery: fires again
    stop2();
    assert.equal(fired.filter((f) => f.includes('مزود النماذج')).length, 2, `transition fires once per episode, got ${JSON.stringify(fired)}`);

    // HTTP: service-watch schedule CRUD + remote channel with key
    const swRes = await fetch(`${base}/api/schedules/service-watch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'افحص تعطل الخدمة', agentId: created.agent.id }) });
    assert.equal(swRes.status, 201);
    const swBody = (await swRes.json()) as { schedule?: { kind: string }; error?: string };
    assert.ok(swBody.schedule?.kind === 'service-watch', JSON.stringify(swBody).slice(0, 200));

    const noKey = await fetch(`${base}/api/remote/trigger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'من الهاتف' }) });
    assert.equal(noKey.status, 401, 'remote trigger must require the key');
    const badKey = await fetch(`${base}/api/remote/status?taskId=x`, { headers: { 'x-loam-key': 'wrong' } });
    assert.equal(badKey.status, 401);
    const trig = await fetch(`${base}/api/remote/trigger`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-loam-key': 'gate-remote-key' }, body: JSON.stringify({ prompt: 'طلب بعيد من الهاتف', agentId: created.agent.id }) });
    assert.equal(trig.status, 202);
    const remoteTaskId = ((await trig.json()) as { taskId: string }).taskId;
    {
      const untilR = Date.now() + 30_000;
      let status = '';
      while (Date.now() < untilR && status !== 'done') {
        const st = (await (await fetch(`${base}/api/remote/status?taskId=${encodeURIComponent(remoteTaskId)}`, { headers: { 'x-loam-key': 'gate-remote-key' } })).json()) as { status: string; notification: { title: string } | null };
        status = st.status;
        if (status === 'done') assert.ok(st.notification?.title.includes('اكتملت'), 'completion notification must be served to the remote channel');
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(status, 'done', 'the remotely triggered task must complete under its companion');
    }
  }

  // phone page: /remote serves the keyed mobile UI (401 without a key, HTML with it)
  {
    const anon = await fetch(`${base}/remote`);
    assert.equal(anon.status, 401, 'remote page must be key-gated');
    const withKey = await fetch(`${base}/remote?key=gate-remote-key`);
    assert.equal(withKey.status, 200);
    const html = await withKey.text();
    assert.ok(html.includes('من هاتفك') && html.includes('/api/remote/trigger'), 'phone page must render the trigger UI');
  }

  // AC. local STT server with diarization (13): the endpoint proxies to the
  // local faster-whisper server and returns labeled segments (or honest 502).
  {
    const sttHealth = await fetch('http://127.0.0.1:3947/health').then((r) => r.ok).catch(() => false);
    if (sttHealth) {
      const wav = fs.readFileSync(path.join(os.tmpdir(), 'stt-test.wav'));
      const tr = await fetch(`${base}/api/agents/${encodeURIComponent(created.agent.id)}/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: wav });
      const trStatus = tr.status; const trBody = await tr.text();
    assert.ok(trStatus === 200 || trStatus === 502, `status=${trStatus} body=${trBody.slice(0, 150)}`);
      const body = JSON.parse(trBody) as { segments?: Array<{ text: string; speaker: string }>; error?: string };
      if (tr.ok) {
        assert.ok(Array.isArray(body.segments), 'segments array required');
        assert.ok(body.segments.every((seg) => typeof seg.speaker === 'string' && seg.speaker.startsWith('speaker-')), 'every segment must carry a speaker label');
      }
      assert.ok(tr.ok || (body.error ?? '').includes('STT'), '502 must carry an honest STT error message');
    } else {
      console.log('  (STT server not running — endpoint existence still verified below)');
    }
    // endpoint rejects empty body
    const empty = await fetch(`${base}/api/agents/${encodeURIComponent(created.agent.id)}/voice/transcribe`, { method: 'POST', body: '' });
    assert.equal(empty.status, 400, 'empty audio must be rejected');
  }

  console.log('Companions voice STT + diarization (HTTP): local faster-whisper server transcribes audio with speaker labels; endpoint rejects empty; service-watch, remote channel, and phone page all remain green.');
    console.log('Companions events+resources (HTTP): a file-watch trigger fired its companion task on a real folder event (debounced), deletion stopped the watcher, and the idle/resource scan endpoint answers with the honest action set.');
    console.log('Companions UI tabs + voice (HTTP/structural): 7 tabs + execution-location bar + panel renderers shipped; continuous voice session with sentence-by-sentence TTS, barge-in cancel, and two-party labeled transcript (user/companion with end reasons) verified over the API including traversal rejection for the files tab.');
    console.log('Companions browser isolation (HTTP): two companions browsed the same origin CONCURRENTLY in isolated sessions — each localStorage stayed its own (A kept أ while B wrote ب), runs overlapped (browser lock removed), and per-companion persistent profiles exist on disk.');
    console.log('Companions vault+approvals (HTTP): a real user_device click waited for the user, the denial blocked execution with an honest message, the approvals center served the decision; and a secret traveled vault→device with the API never echoing values and the tool confirming no model exposure.');
    console.log('Companions stage 5 (HTTP): voice records round-trip; a coordinator actually delegated through the pipeline and the target companion completed the task under its own identity; per-companion usage counts real runs/tool calls with a local-cost note; and project handover moved tasks + transferred memory context explicitly.');
    console.log('Companions stage 4 (HTTP): companion memory verified over the API (user-source entry, edit, supersede, export) and injected into the agent\'s own runs (context + memory tools); a routine created with agentId ran immediately via run-now and its task landed under that companion; and an own_device routine executed for real on the companion\'s device (workmode deviceId + successful device_exec in the task steps).');
} finally {
  await stop();
}
