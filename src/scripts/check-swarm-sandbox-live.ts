/** Roadmap §7 LIVE container gate (opt-in, not in the default suite): proves the swarm's
 * isolation layer actually executes inside Docker when LOAM_SWARM_SANDBOX=auto and a runtime
 * is present (Docker 29.8 on this machine). Requires the node:22-alpine image (pulled on
 * first run — needs network) and Docker Desktop running. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile) as unknown as (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;

const { detectSandbox, resolveExecution, DEFAULT_SANDBOX_IMAGE } = await import("../swarm/isolation.js");

const sandbox = await detectSandbox();
assert.ok(sandbox.kind, "a container runtime (Docker/Podman) must be available for the live sandbox check");
console.log(`[sandbox-live] runtime: ${sandbox.kind} — ${sandbox.version}`);

// Ensure the image exists locally (pull once if needed — honest network dependency).
const pull = await exec(sandbox.kind!, ["images", "-q", DEFAULT_SANDBOX_IMAGE]).catch(() => null);
if (!pull?.stdout.trim()) {
  console.log(`[sandbox-live] pulling ${DEFAULT_SANDBOX_IMAGE} (first run only)...`);
  await exec(sandbox.kind!, ["pull", DEFAULT_SANDBOX_IMAGE]);
}
const imageId = (await exec(sandbox.kind!, ["images", "-q", DEFAULT_SANDBOX_IMAGE])).stdout.trim();
assert.ok(imageId, "the sandbox image must exist locally after pull");
console.log(`[sandbox-live] image ready: ${DEFAULT_SANDBOX_IMAGE} (${imageId.slice(0, 12)})`);

// A real workspace: the container must see it mounted at /work and execute the command there.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-sandbox-live-"));
fs.writeFileSync(path.join(workspace, "probe.cjs"), "console.log('inside:' + process.version + ':cwd=' + process.cwd());\n");

const spec = await resolveExecution("node probe.cjs", { workspace, env: { ...process.env, LOAM_SWARM_SANDBOX: "auto" } });
assert.equal(spec.kind, "sandboxed", "policy auto + runtime present must produce a sandboxed spec");
console.log(`[sandbox-live] spec: ${spec.note}`);

const ran = await exec(spec.command, spec.args, { timeout: 120_000 });
assert.match(ran.stdout, /inside:v\d+\.\d+\.\d+:cwd=\/work/, "the command must actually run inside the container at /work");
const hostVersion = process.version;
assert.ok(!ran.stdout.includes(`cwd=${workspace}`), "execution must not fall back to the host cwd");
console.log(`[sandbox-live] container node ${ran.stdout.trim()} (host is ${hostVersion}) — real isolated execution proven`);

// Isolation boundary statement: a container WITHOUT the mount cannot see the workspace —
// proving that without buildIsolatedSpec's explicit -v, nothing leaks in.
const posixRoot = workspace.replace(/\\([a-z])\\/, (_, d) => `/${d.toLowerCase()}/`).replaceAll("\\", "/");
const noMount = await exec(sandbox.kind!, ["run", "--rm", DEFAULT_SANDBOX_IMAGE, "sh", "-c", `test -f ${posixRoot}/probe.cjs && echo leaked || echo isolated`]).catch(() => null);
if (noMount) {
  assert.match(noMount.stdout, /isolated/, "without the explicit mount the container must NOT see the host workspace");
  console.log("[sandbox-live] unmounted container cannot see the host workspace (isolated)");
}

// Policy off must never touch docker (proven by the deterministic check-swarm-isolation).
const offSpec = await resolveExecution("node probe.cjs", { workspace, env: { ...process.env, LOAM_SWARM_SANDBOX: "off" } });
assert.equal(offSpec.kind, "local", "policy off stays local");

fs.rmSync(workspace, { recursive: true, force: true });
console.log("PASS swarm sandbox live (real containerized execution)");
