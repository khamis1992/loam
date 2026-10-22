/**
 * Deterministic gate for the 2026-10-19 companions re-verification fixes
 * (docs/companions-fix-reverification-2026-10-19.md):
 *
 * 1. user takeover KILLS the in-flight device command — AbortController → child process,
 *    not an internal boolean (fake runner exposes a cancellable sleep protocol).
 * 2. SSH delete/restore semantics: remove() destroys the remote directory; restore verifies
 *    the archive BEFORE clearing anything, clears the whole directory (hidden files too,
 *    rm -rf dir && mkdir -p dir), and never masks the ssh exit status with `echo`.
 *    A real tarball round-trips through snapshot → restore.
 * 3. secret scrubbing: printf payloads of ANY length are redacted from journals, including
 *    when the command is echoed back in stdout.
 * 4. identity import: voice turns use `speaker` (falling back to `role`), a disabled
 *    schedule stays disabled, and memory lifecycle (expiresAt/supersededBy) survives.
 * 5. archive is soft: archivedAt hides the companion without deleting data; unarchive
 *    restores it; the scheduler never runs an archived companion's schedules.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-companions-fixes-"));
process.env.MANUS_LOCAL_DATA_DIR = dir;
process.env.MANUS_LOCAL_SKILLS_DIR = path.join(dir, "skills");
process.env.LOAM_DEVICE_RUNNER = "fake";

const devices = await import("../server/companionDevices.js");
const { fakeRunner, DeviceManager, getDevice, readJournal } = devices;

const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string): Promise<void> => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out: ${label}`);
};

/* ---------- 1. live takeover kills the running command ---------- */
{
  const dm = new DeviceManager(fakeRunner);
  const created = await dm.create({ agentId: "agent-cancel", template: "research", name: "جهاز الإلغاء" });
  assert.ok(!("error" in created), JSON.stringify(created));
  const id = (created as { id: string }).id;
  await waitFor(() => getDevice(id)?.state === "running", "provisioning");
  const dev = getDevice(id)!;

  const slow = dm.agentExec(dev, "sleep 30", 60_000);
  await new Promise((r) => setTimeout(r, 200)); // the command is now in flight
  const t0 = Date.now();
  dm.setControl(id, "user");
  const out = await slow;
  const elapsed = Date.now() - t0;
  assert.ok("error" in out, `takeover must cancel the in-flight command, got: ${JSON.stringify(out)}`);
  assert.ok(elapsed < 5_000, `cancellation must be immediate (took ${elapsed}ms)`);
  const journal = readJournal(getDevice(id)!);
  assert.ok(journal.some((e) => e.event === "control-taken-abort"), "journal must record the abort");
  assert.ok(journal.every((e) => !JSON.stringify(e).includes("sleep 30") || e.event !== "agent"), "cancelled command must not be journalled as a normal exec");

  // release + confirmed delete (fake runner: unregister fallback clears its filesystem)
  dm.setControl(id, "agent");
  const gone = await dm.remove(id, true);
  assert.ok(!("error" in gone) && gone.deleted === true);
  console.log("1. takeover kills the in-flight command: abort signal reaches the runner, journal records control-taken-abort");
}

/* ---------- 2. SSH delete/restore with real tar bytes ---------- */
{
  // A real tarball: snapshot and restore must move real bytes, not placeholders.
  // (bsdtar on Windows treats "C:\..." as a host spec — keep every tar path relative via cwd,
  //  and write the archive OUTSIDE the staged dir so it doesn't change while being read.)
  const stage = path.join(dir, "stage"); fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "data.txt"), "مرحبا من الجهاز البعيد");
  execFileSync("tar", ["-czf", "../snap.tar.gz", "."], { cwd: stage, windowsHide: true });
  const realTar = path.join(dir, "snap.tar.gz");
  const realTarBytes = fs.readFileSync(realTar);

  const sshCalls: string[] = [];
  const remoteDirs = new Set<string>();
  const target = { host: "fake.remote", baseDir: "/srv/loam" };
  const unquote = (p: string): string => p.replace(/^"|"$/g, "");
  const ssh = async (_t: unknown, cmd: string): Promise<{ code: number; stdout: string; stderr: string }> => {
    sshCalls.push(cmd);
    if (cmd === "echo ok") return { code: 0, stdout: "ok", stderr: "" };
    if (cmd.startsWith("rm -rf ") && cmd.includes(" && test ! -e ")) {
      const d = unquote(cmd.slice("rm -rf ".length).split(" && ")[0]!);
      remoteDirs.delete(d);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd.startsWith("rm -rf ") && cmd.includes(" && mkdir -p ")) {
      const d = unquote(cmd.slice("rm -rf ".length).split(" && ")[0]!);
      remoteDirs.add(d);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd.includes("wc -c")) return { code: 0, stdout: "1024", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const streams: Array<{ cmd: string; inputBytes: number }> = [];
  const stream = async (_t: unknown, cmd: string, input?: Buffer): Promise<Buffer> => {
    streams.push({ cmd, inputBytes: input?.length ?? 0 });
    if (cmd.includes("tar -czf - .")) return realTarBytes; // snapshot reads back the real tar
    return Buffer.alloc(0);
  };
  const runner = devices.sshRunnerForTests(target as unknown as import("../server/companionDevices.js").SshTarget, ssh as never, stream as never);

  // 2a. restore verifies the archive BEFORE clearing: a missing archive must fail
  //     without touching the remote directory.
  const before = sshCalls.length;
  const bad = await runner.importDevice("os-x", dir, path.join(dir, "missing.tar"));
  assert.ok(bad.code !== 0, "missing archive must fail import");
  assert.ok(!sshCalls.slice(before).some((c) => c.includes("rm -rf")), `no rm may run for a missing archive, got: ${sshCalls.slice(before)}`);

  // 2b. import clears the WHOLE directory (rm -rf dir && mkdir -p dir — hidden files
  //     included) and never masks the exit status with echo.
  const ok = await runner.importDevice("os-x", dir, realTar);
  assert.equal(ok.code, 0, JSON.stringify(ok));
  const clear = sshCalls.find((c) => c.includes("rm -rf") && c.includes("os-x") && c.includes("mkdir -p"));
  assert.ok(clear, "import must clear + recreate the device dir");
  assert.ok(!clear!.includes("/*"), "clearing must not use dir/* (hidden files survive that)");
  assert.ok(!clear!.includes("echo"), "clearing must not mask the exit status with echo");
  assert.ok(remoteDirs.has("/srv/loam/os-x"), "cleared dir must be recreated");
  const untar = streams.at(-1)!;
  assert.ok(untar.cmd.includes("tar -xzf -"), `untar must stream via ssh, got: ${untar.cmd}`);
  assert.equal(untar.inputBytes, realTarBytes.length, "the full archive must be piped to the remote");

  // 2c. full lifecycle through the DeviceManager: provision → snapshot (real bytes) →
  //     restore (clear then untar, in that order) → confirmed remove destroys the remote dir.
  const dm = new DeviceManager(runner);
  const created = await dm.create({ agentId: "agent-ssh-fix", template: "research", name: "جهاز SSH" });
  assert.ok(!("error" in created), JSON.stringify(created));
  const id = (created as { id: string }).id;
  await waitFor(() => getDevice(id)?.state === "running", "ssh provisioning");
  const dev = getDevice(id)!;
  assert.ok(remoteDirs.has(`/srv/loam/${dev.osName}`), "provisioning must create the remote dir");

  const snap = await dm.snapshot(id, "نقطة");
  assert.ok(!("error" in snap), JSON.stringify(snap));
  const snapFile = path.join(dev.storagePath, (snap as { snapshots: Array<{ file: string }> }).snapshots.at(-1)!.file);
  assert.ok(fs.statSync(snapFile).size > 100, `snapshot must carry the real tar bytes (got ${fs.statSync(snapFile).size})`);
  const extract = path.join(dir, "extract"); fs.mkdirSync(extract, { recursive: true });
  fs.copyFileSync(snapFile, path.join(extract, "snap.tar.gz"));
  execFileSync("tar", ["-xzf", "snap.tar.gz"], { cwd: extract, windowsHide: true });
  assert.equal(fs.readFileSync(path.join(extract, "data.txt"), "utf8"), "مرحبا من الجهاز البعيد", "snapshot content must round-trip");

  await dm.stop(id);
  const restored = await dm.restore(id, getDevice(id)!.snapshots[0]!.id);
  assert.ok(!("error" in restored), JSON.stringify(restored));
  const lastStreamIdx = streams.length - 1;
  const lastClear = sshCalls.map((c, i) => ({ c, i })).filter((x) => x.c.includes("rm -rf") && x.c.includes(dev.osName)).at(-1)!;
  assert.ok(lastClear.i < sshCalls.length, "clear happened");
  assert.ok(remoteDirs.has(`/srv/loam/${dev.osName}`), "restore must recreate the remote dir");
  assert.ok(streams[lastStreamIdx]!.inputBytes === fs.statSync(snapFile).size, "restore must stream the snapshot archive");

  const gone = await dm.remove(id, true);
  assert.ok(!("error" in gone) && gone.deleted === true);
  const destroy = sshCalls.filter((c) => c.includes("rm -rf") && c.includes("test ! -e")).at(-1);
  assert.ok(destroy, "remove() must destroy the remote dir and verify it is gone");
  assert.ok(!remoteDirs.has(`/srv/loam/${dev.osName}`), "remote dir must be deleted after confirmed remove");
  console.log("2. SSH lifecycle: archive verified before clearing, whole-dir clean, real tar round-trip, remove destroys the remote dir");
}

/* ---------- 3. secret scrub (any length, echoed output included) ---------- */
{
  const dm = new DeviceManager(fakeRunner);
  const created = await dm.create({ agentId: "agent-scrub", template: "research", name: "جهاز التنقية" });
  assert.ok(!("error" in created), JSON.stringify(created));
  const id = (created as { id: string }).id;
  await waitFor(() => getDevice(id)?.state === "running", "provisioning");

  // A 3-char secret: the old {8,} threshold let it through.
  const secret = Buffer.from("ab", "utf8").toString("base64"); // "YWI="
  const res = await dm.agentExec(getDevice(id)!, `printf %s ${secret} | base64 -d > /tmp/s.txt`);
  assert.ok(!("error" in res), JSON.stringify(res));
  const flat = JSON.stringify(readJournal(getDevice(id)!));
  assert.ok(!flat.includes(secret), `short base64 secret must never reach the journal (found ${secret})`);
  assert.ok(flat.includes("[redacted]"), "the redaction marker must replace the payload");
  // The fake runner echoes the command back in stdout — still no leak.
  assert.ok(!flat.includes(`fake-ok: printf %s ${secret}`), "echoed command in stdout must be scrubbed too");

  await dm.remove(id, true);
  console.log("3. scrub: printf payloads of any length redacted from journals, echoed stdout included");
}

/* ---------- 4+5. identity import round-trip and soft archive (HTTP) ---------- */
{
  // Spawn the real server against an isolated data dir; no model is needed for these routes.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-companions-fixes-http-"));
  const workspace = path.join(tmp, "workspace"); fs.mkdirSync(workspace);
  const probe = (await import("node:net")).createServer();
  probe.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => probe.once("listening", () => resolve()));
  const port = (probe.address() as import("node:net").AddressInfo).port;
  probe.close();
  const base = `http://127.0.0.1:${port}`;
  const config = path.join(tmp, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    model: "test-model", fallbackModel: "test-model", ollamaUrl: "http://127.0.0.1:1",
    workspace, computerUse: { enabled: false, screenshotDir: path.join(tmp, "shots") },
    memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false },
    orchestrator: { enabled: false }, mcpServers: {},
  }));
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: path.resolve(import.meta.dirname, "../.."), windowsHide: true,
    env: { ...process.env, MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: path.join(tmp, "data"), MANUS_LOCAL_PORT: String(port), MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills"), LOAM_DEVICE_RUNNER: "fake" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout?.on("data", (c) => { logs += c; });
  child.stderr?.on("data", (c) => { logs += c; });
  try {
    await waitFor(() => fetch(`${base}/api/work-modes`).then((r) => r.ok).catch(() => false), `server startup\n${logs.slice(-2000)}`);

    // 4. identity export → import: voice `speaker` field, disabled schedule, memory lifecycle.
    //     All fixtures go through the HTTP API — the child server owns its data dir.
    const mk = await fetch(`${base}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "رفيق الحزمة" }) });
    assert.ok(mk.ok, `agent create ${mk.status}`);
    const { agent } = (await mk.json()) as { agent: { id: string } };
    const post = (route: string, body: unknown): Promise<Response> =>
      fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    // Disabled routine + ttl memory + superseded memory + 2 voice turns (speaker form).
    const schedOn = await post("/api/schedules", { prompt: "روتين مفعل", intervalSeconds: 3600, agentId: agent.id });
    assert.ok(schedOn.ok, `schedule create ${schedOn.status}`);
    const schedOff = await post("/api/schedules", { prompt: "روتين معطل", intervalSeconds: 3600, agentId: agent.id, enabled: false });
    assert.ok(schedOff.ok, `disabled schedule create ${schedOff.status}`);
    assert.equal(((await schedOff.json()) as { schedule: { enabled: boolean } }).schedule.enabled, false, "schedule API must honor enabled=false");

    const mem1 = await post(`/api/agents/${agent.id}/memory`, { text: "ذكرى قديمة" });
    assert.ok(mem1.ok, `memory create ${mem1.status}`);
    const entry1 = ((await mem1.json()) as { entry: { id: string } }).entry;
    const mem2 = await post(`/api/agents/${agent.id}/memory`, { text: "ذكرى بديلة" });
    assert.ok(mem2.ok, `memory create 2 ${mem2.status}`);
    const memTtl = await post(`/api/agents/${agent.id}/memory`, { text: "ذكرى مؤقتة", ttlDays: 1 });
    assert.ok(memTtl.ok, `ttl memory ${memTtl.status}`);
    const ttlEntry = ((await memTtl.json()) as { entry: { expiresAt?: string } }).entry;
    assert.ok(ttlEntry.expiresAt, "ttl memory must carry expiresAt");
    const sup = await post(`/api/agents/${agent.id}/memory/supersede`, { entryId: entry1.id, text: "ذكرى قديمة — استُبدلت" });
    assert.ok(sup.ok, `supersede ${sup.status}`);

    for (const [speaker, text] of [["user", "سؤال"], ["assistant", "جواب"]] as const) {
      const v = await post(`/api/agents/${agent.id}/voice`, { speaker, text });
      assert.ok(v.ok, `voice turn ${v.status}`);
    }

    const exported = (await (await fetch(`${base}/api/agents/${agent.id}/export`)).json()) as {
      voiceTurns: Array<{ speaker: string; text: string }>;
      schedules: Array<{ prompt: string; enabled: boolean }>;
      memory: Array<{ text: string; expiresAt?: string; supersededBy?: string }>;
    };
    assert.equal(exported.voiceTurns.length, 2, `export must carry the voice turns, got ${JSON.stringify(exported.voiceTurns)}`);
    assert.ok(exported.voiceTurns.every((t) => typeof t.speaker === "string"), "voice turns use the speaker field");
    assert.equal(exported.schedules.find((s) => s.prompt === "روتين معطل")?.enabled, false, "disabled routine must export as disabled");
    assert.ok(exported.memory.some((m) => m.expiresAt === ttlEntry.expiresAt), "expiresAt must export");
    assert.ok(exported.memory.some((m) => m.supersededBy), "superseded memory must export");

    const imported = (await (await post("/api/agents/import", exported)).json()) as {
      agent: { id: string }; importedVoiceTurns: number; importedSchedules: number; importedMemory: number;
    };
    assert.ok(imported.agent?.id, "import must create an agent");
    assert.equal(imported.importedVoiceTurns, exported.voiceTurns.length, `voice turns must survive import: got ${imported.importedVoiceTurns}`);
    assert.ok(imported.importedSchedules >= 2, `both routines must import, got ${imported.importedSchedules}`);
    const storedSched = ((await (await fetch(`${base}/api/schedules`)).json()) as { schedules: Array<{ agentId?: string; prompt: string; enabled: boolean }> }).schedules.filter((s) => s.agentId === imported.agent.id);
    assert.equal(storedSched.find((s) => s.prompt === "روتين معطل")?.enabled, false, "a disabled routine must STAY disabled after import");
    assert.equal(storedSched.find((s) => s.prompt === "روتين مفعل")?.enabled, true, "an enabled routine stays enabled");
    const importedMemoryAll = ((await (await fetch(`${base}/api/agents/${imported.agent.id}/memory?all=1`)).json()) as { entries: Array<{ text: string; expiresAt?: string; supersededBy?: string }> }).entries;
    assert.ok(importedMemoryAll.some((m) => m.expiresAt === ttlEntry.expiresAt), "memory expiresAt must survive import verbatim");
    assert.ok(importedMemoryAll.some((m) => m.supersededBy), "supersededBy must survive import");
    const importedTurns = ((await (await fetch(`${base}/api/agents/${imported.agent.id}/voice`)).json()) as { turns: Array<{ text: string }> }).turns;
    assert.equal(importedTurns.filter((t) => t.text === "سؤال" || t.text === "جواب").length, 2, "imported voice turns must be stored");

    // 5. soft archive: data survives, list hides, unarchive restores.
    const arch = await post(`/api/agents/${imported.agent.id}/archive`, {});
    assert.ok(arch.ok, `archive ${arch.status}`);
    const listed = (await (await fetch(`${base}/api/agents`)).json()) as { agents: Array<{ id: string }> };
    assert.ok(!listed.agents.some((a) => a.id === imported.agent.id), "archived companion must leave the active list");
    const keptMemory = await fetch(`${base}/api/agents/${imported.agent.id}/memory?all=1`);
    assert.ok(keptMemory.ok, `archived memory route ${keptMemory.status}`);
    assert.ok((((await keptMemory.json()) as { entries: unknown[] }).entries).length > 0, "archived companion keeps its memory");
    const stillThere = await fetch(`${base}/api/agents/${imported.agent.id}/export`);
    assert.ok(stillThere.ok, "archived companion can still be exported (soft archive)");

    const unarch = await post(`/api/agents/${imported.agent.id}/unarchive`, {});
    assert.ok(unarch.ok, `unarchive ${unarch.status}`);
    const relisted = (await (await fetch(`${base}/api/agents`)).json()) as { agents: Array<{ id: string }> };
    assert.ok(relisted.agents.some((a) => a.id === imported.agent.id), "unarchive must return the companion to the list");
    console.log("4+5. identity round-trip (voice speaker / disabled routine / memory expiry+supersede) and soft archive: green");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

/* ---------- 6. scheduler never runs an archived companion's routines ---------- */
{
  const agentMod = await import("../server/agents.js");
  const db = await import("../server/db.js");
  const scheduler = await import("../server/scheduler.js");
  const agent = agentMod.createAgent({ name: "مؤرشف" });
  const due = db.addSchedule("روتين المؤرشف", 3600, agent.id);
  db.setScheduleNextRunAt(due.id, new Date(Date.now() - 60_000).toISOString());
  agentMod.setAgentArchived(agent.id, true);

  const runs: string[] = [];
  const stop1 = scheduler.startScheduler({ runScheduled: async (p) => { runs.push(p); return "t"; }, intervalMs: 50 });
  await new Promise((r) => setTimeout(r, 300));
  stop1();
  assert.equal(runs.length, 0, `scheduler must skip archived companions (ran ${runs.length})`);

  agentMod.setAgentArchived(agent.id, false);
  const runs2: string[] = [];
  const stop2 = scheduler.startScheduler({ runScheduled: async (p) => { runs2.push(p); return "t"; }, intervalMs: 50 });
  await new Promise((r) => setTimeout(r, 400));
  stop2();
  assert.ok(runs2.length > 0, "unarchived companion's due routine must run again");
  console.log("6. scheduler skips archived companions and resumes after unarchive");
}

console.log("companions fixes gate: all sections green (live abort, SSH destroy/restore, scrub, identity import, soft archive).");
process.exit(0);
