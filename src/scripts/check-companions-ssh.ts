/**
 * REAL SSH-provider evidence (frontier 4): the SshDeviceRunner drives a genuine
 * openssh-server (running inside the Ubuntu-24.04 WSL distro) at 127.0.0.1:2202 —
 * the same code path a real remote server would use. Opt-in like the other real
 * gates: needs `wsl -d Ubuntu-24.04 ... /usr/sbin/sshd -p 2202` and the key at
 * %TEMP%/loam-ssh-key (see the setup commands in the frontier doc).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const keyFile = path.join(os.tmpdir(), "loam-ssh-key");
assert.ok(fs.existsSync(keyFile), `ssh key missing: ${keyFile} — run the sshd setup from docs/companions-frontier-progress.md`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ssh-evidence-"));
process.env.MANUS_LOCAL_DATA_DIR = dir;
// reuse the prepared golden rootfs (same file the WSL provider uses)
fs.mkdirSync(path.join(dir, "devices"), { recursive: true });
const goldenSrc = path.join(os.tmpdir(), "loam-golden", "golden-linux.tar");
if (fs.existsSync(goldenSrc)) fs.copyFileSync(goldenSrc, path.join(dir, "devices", "golden-linux.tar"));

const devices = await import("../server/companionDevices.js");
const { SshDeviceRunner } = devices;

const target = { host: "127.0.0.1", port: 2202, user: "loamssh", baseDir: "/tmp/loam-devices", keyFile };
const runner = new SshDeviceRunner(target);

// 1. detection over a real ssh handshake
const providers = await runner.detect();
assert.ok(providers.wsl === true, `real ssh detect must succeed: ${JSON.stringify(providers)}`);
console.log("detect: reachable over real ssh");

// 2. device lifecycle through the DeviceManager on the remote host
const dm = new devices.DeviceManager(runner);
const created = await dm.create({ agentId: "agent-ssh-real", template: "coding", name: "جهاز SSH بعيد" });
assert.ok(!("error" in created), JSON.stringify(created));
const id = (created as { id: string }).id;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = Date.now() + 30_000;
for (;;) {
  const d = devices.getDevice(id);
  if (d?.state === "running") break;
  if (d?.state === "error" || Date.now() > until) throw new Error(`provisioning: ${JSON.stringify(d)}`);
  await sleep(100);
}
console.log(`provisioned remote device ${id} (state=running)`);

// 3. real exec inside the device's dedicated directory on the REMOTE host
const write = await dm.agentExec(devices.getDevice(id)!, "printf %s $(printf 'مرحبا من الجهاز البعيد عبر SSH' | base64 -w0) | base64 -d > remote.md && echo done");
assert.ok(!("error" in write) && write.code === 0, JSON.stringify(write));
const read = await dm.agentExec(devices.getDevice(id)!, "base64 -w0 remote.md");
assert.ok(!("error" in read) && read.code === 0);
assert.equal(Buffer.from(read.stdout, "base64").toString("utf8"), "مرحبا من الجهاز البعيد عبر SSH", "Arabic content must round-trip over the real ssh device");
console.log("exec round-trip inside the remote device: ok (Arabic preserved)");

// 4. snapshot over real ssh (tar streamed back) then verify the archive
const snap = await dm.snapshot(id, "نقطة عبر SSH");
assert.ok(!("error" in snap), JSON.stringify(snap));
const snapRec = devices.getDevice(id)!.snapshots[0]!;
const snapFile = path.join(devices.getDevice(id)!.storagePath, snapRec.file);
assert.ok(fs.existsSync(snapFile) && fs.statSync(snapFile).size > 200, `real ssh snapshot must produce a tar (got ${snapFile})`);
console.log(`snapshot over ssh: ${snapFile} (${fs.statSync(snapFile).size} bytes)`);

// 5. honest remote semantics: terminate is a no-op (the remote host owns power)
await dm.stop(id);
assert.notEqual(devices.getDevice(id)?.state, "running");

// 6. cleanup removes the remote directory
const gone = await dm.remove(id, true);
assert.ok(!("error" in gone) && gone.deleted === true);
console.log("REAL SSH provider cycle green: detect → provision (remote dir) → exec round-trip → ssh-streamed snapshot → stop → confirmed delete.");
process.exit(0);
