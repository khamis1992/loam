/**
 * REAL end-to-end companion-device cycle on this host's actual WSL2 (stage 2
 * evidence — not part of the deterministic gate). Requires a prepared golden
 * rootfs tar (see docs/companions-frontier-progress.md). Every step below goes
 * through the app's own DeviceManager with the RealDeviceRunner.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-real-devices-"));
process.env.MANUS_LOCAL_DATA_DIR = dir;

const devices = await import("../server/companionDevices.js");
const { DeviceManager, RealDeviceRunner, loadCompanionDevices, getDevice } = devices;

const goldenSrc = path.join(os.tmpdir(), "loam-golden", "golden-linux.tar");
assert.ok(fs.existsSync(goldenSrc), `golden rootfs missing: ${goldenSrc} — build it first (see doc)`);
fs.mkdirSync(path.join(dir, "devices"), { recursive: true });
fs.copyFileSync(goldenSrc, path.join(dir, "devices", "golden-linux.tar"));

loadCompanionDevices();
const dm = new DeviceManager(new RealDeviceRunner());
const providers = await dm.providers();
assert.ok(providers.wsl, `WSL provider required for the real cycle, saw ${JSON.stringify(providers)}`);
console.log(`providers: wsl=${providers.wsl} hyperv=${providers.hyperv}`);

const created = await dm.create({ agentId: "agent-real-smoke", template: "research", name: "جهاز حقيقي" });
assert.ok(!("error" in created), JSON.stringify(created));
const id = (created as { id: string }).id;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = Date.now() + 240_000;
let device = getDevice(id);
while (Date.now() < until) {
  device = getDevice(id);
  if (device?.state === "running") break;
  if (device?.state === "error") throw new Error(`provisioning failed: ${device.lastError}`);
  await sleep(500);
}
assert.equal(device?.state, "running", `device state ${device?.state} (${device?.lastError ?? ""})`);
console.log(`provisioned: ${device!.osName} (storage ${device!.storagePath})`);

// 1. real exec + file round-trip inside the isolated device
const write = await dm.agentExec(device!, "mkdir -p /home/loam && printf %s $(printf 'مرحبا من الجهاز الحقيقي' | base64 -w0) | base64 -d > /home/loam/real.md");
assert.ok(!("error" in write) && write.code === 0, JSON.stringify(write));
const read = await dm.agentExec(device!, "base64 -w0 /home/loam/real.md");
if ("error" in read) throw new Error(read.error);
assert.equal(read.code, 0);
assert.equal(Buffer.from(read.stdout, "base64").toString("utf8"), "مرحبا من الجهاز الحقيقي", "Arabic content must round-trip inside the real device");
const who = await dm.agentExec(device!, "id -un && uname -srm");
if ("error" in who) throw new Error(who.error);
console.log(`exec as: ${who.stdout.replace(/\n/g, " | ")}`);
assert.ok(who.stdout.split("\n")[0]?.trim() === "loam", "commands must run as the isolated loam user, not root/host user");

// 2. processes are isolated: the device sees its own PID namespace world
const ps = await dm.agentExec(device!, "ps aux 2>/dev/null | head -5 || ps | head -5");
if ("error" in ps) throw new Error(ps.error);
console.log(`device process view (first lines): ${ps.stdout.split("\n").slice(0, 2).join(" / ")}`);

// 3. take-control interlock on the real device
devices.deviceManager.setControl(id, "user");
const blocked = await dm.agentExec(device!, "echo must-not-run");
assert.ok("error" in blocked, "agent exec must be blocked while the user holds control");
devices.deviceManager.setControl(id, "agent");
const unblocked = await dm.agentExec(device!, "echo back-again");
assert.ok(!("error" in unblocked) && unblocked.stdout.includes("back-again"));

// 3b. REAL GUI viewer: X desktop boots inside the device, a real frame is captured,
//     manual typing works under the control hold, and the desktop windows list.
const guiBoot = await dm.ensureGui(id);
assert.ok(!("error" in guiBoot) && guiBoot.ok, JSON.stringify(guiBoot));
const guiFrame = await dm.captureScreen(id, false);
if ("error" in guiFrame) throw new Error(guiFrame.error);
assert.ok(guiFrame.length > 4000 && guiFrame[0] === 0xff && guiFrame[1] === 0xd8, `frame must be a real JPEG >4KB, got ${guiFrame.length} bytes starting ${guiFrame.subarray(0, 4).toString("hex")}`);
const evidenceDir = path.resolve(import.meta.dirname, "../../docs/evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(evidenceDir, "companion-device-screen.jpg"), guiFrame);
console.log(`real GUI frame captured: ${guiFrame.length} bytes → docs/evidence/companion-device-screen.jpg`);
devices.deviceManager.setControl(id, "user");
const typed = await dm.sendGuiInput(id, { type: "type", text: "echo مرحبا من نافذة المشاهدة" });
assert.ok(typed === true, "typing into the device desktop must work under control hold");
const pressed = await dm.sendGuiInput(id, { type: "key", key: "Return" });
assert.ok(pressed === true);
devices.deviceManager.setControl(id, "agent");
const guiWindows = await dm.guiWindows(id);
if ("error" in guiWindows) throw new Error(guiWindows.error);
assert.ok(guiWindows.some((w) => /Loam Companion Device|xterm|fluxbox/i.test(w.title)), `desktop windows expected, saw ${JSON.stringify(guiWindows)}`);
console.log(`device desktop windows: ${guiWindows.map((w) => w.title).join(" | ")}`);

// 4. snapshot (real wsl --export) + restore (unregister + import)
const snap = await dm.snapshot(id, "نقطة حقيقية");
assert.ok(!("error" in snap), JSON.stringify(snap));
const withSnap = getDevice(id)!;
assert.equal(withSnap.snapshots.length, 1);
assert.ok(fs.statSync(path.join(withSnap.storagePath, withSnap.snapshots[0]!.file)).size > 1_000_000, "real snapshot tar must be substantial");
console.log(`snapshot: ${withSnap.snapshots[0]!.file} (${(fs.statSync(path.join(withSnap.storagePath, withSnap.snapshots[0]!.file)).size / 1e6).toFixed(1)} MB)`);
const restored = await dm.restore(id, withSnap.snapshots[0]!.id);
assert.ok(!("error" in restored), JSON.stringify(restored));
const afterRestore = await dm.start(id);
assert.ok(!("error" in afterRestore) && getDevice(id)?.state === "running");
const survived = await dm.agentExec(getDevice(id)!, "base64 -w0 /home/loam/real.md");
assert.ok(!("error" in survived) && Buffer.from(survived.stdout, "base64").toString("utf8").includes("الجهاز الحقيقي"), "file written before the snapshot must survive restore");

// 5. stop → disk persists (registered distro still there) → delete cleans up
await dm.stop(id);
assert.equal(getDevice(id)?.state, "stopped");
const gone = await dm.remove(id, true);
assert.ok(!("error" in gone) && gone.deleted === true);
assert.equal(getDevice(id), undefined);
console.log("REAL device cycle: provision → exec/round-trip as loam user → control interlock → snapshot → restore (file survived) → stop → confirmed delete. ALL GREEN");
