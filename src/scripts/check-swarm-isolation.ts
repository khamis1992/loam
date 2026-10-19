import assert from "node:assert/strict";
import {
  DEFAULT_SANDBOX_IMAGE,
  buildIsolatedSpec,
  detectSandbox,
  readPolicy,
  resolveExecution,
  winToPosix,
} from "../swarm/isolation.js";

// Deterministic checks for the swarm isolation layer (roadmap §7). All probing
// goes through injected fake runners so nothing here depends on this machine
// having a container runtime — except one honest real-default-detection call
// whose result is only type-checked and reported, never assumed.

// 1. detectSandbox — docker responds: first probe wins, version is the trimmed stdout.
const dockerProbes: Array<[string, string[]]> = [];
const dockerInfo = await detectSandbox(async (cmd, args) => {
  dockerProbes.push([cmd, args]);
  return cmd === "docker" ? { stdout: "Docker version 24.0.7, build afdd53b\n" } : null;
});
assert.deepEqual(dockerInfo, { kind: "docker", version: "Docker version 24.0.7, build afdd53b" });
assert.deepEqual(dockerProbes, [["docker", ["--version"]]]); // probe shape; stops after the first hit

// 2. docker fails → podman responds.
const podmanProbes: string[] = [];
const podmanInfo = await detectSandbox(async (cmd, args) => {
  podmanProbes.push(cmd);
  assert.deepEqual(args, ["--version"]);
  return cmd === "docker" ? null : { stdout: "podman version 4.9.3" };
});
assert.deepEqual(podmanInfo, { kind: "podman", version: "podman version 4.9.3" });
assert.deepEqual(podmanProbes, ["docker", "podman"]);

// 3. Both fail → null sandbox (the documented degraded state).
assert.deepEqual(await detectSandbox(async () => null), { kind: null, version: null });

// 4. Real default runner on this host: no assumption, just type sanity + report.
const host = await detectSandbox();
assert(host.kind === null || host.kind === "docker" || host.kind === "podman");
assert(host.kind === null ? host.version === null : typeof host.version === "string");
console.log(
  `[swarm-isolation] host detection: ${host.kind ? `${host.kind} — ${host.version}` : "no container runtime (local fallback)"}`,
);

// 5. buildIsolatedSpec — sandboxed docker on a Windows workspace path.
const sandboxed = buildIsolatedSpec("npm test", { sandbox: { kind: "docker", version: "Docker version 24.0.7" }, workspace: "C:\\users\\x\\work" });
assert.equal(sandboxed.kind, "sandboxed");
assert.equal(sandboxed.command, "docker");
assert.deepEqual(sandboxed.args, ["run", "--rm", "-v", "/c/users/x/work:/work", "-w", "/work", "node:22-alpine", "sh", "-c", "npm test"]);
assert.deepEqual(sandboxed.args.slice(-3), ["sh", "-c", "npm test"]); // command runs via sh -c as the tail
assert(sandboxed.note.includes("node:22-alpine") && sandboxed.note.includes("docker"));

// Custom image honored; podman runtime honored; POSIX workspace passes through.
const custom = buildIsolatedSpec("npm run build", { sandbox: { kind: "podman", version: null }, workspace: "/srv/w", image: "node:20-bookworm" });
assert.equal(custom.command, "podman");
assert.equal(custom.args[6], "node:20-bookworm");
assert.equal(custom.args[3], "/srv/w:/work");
assert(custom.note.includes("node:20-bookworm") && custom.note.includes("podman"));
assert.equal(DEFAULT_SANDBOX_IMAGE, "node:22-alpine");

// 6. Local fallback spec.
const local = buildIsolatedSpec("npm test", { sandbox: { kind: null, version: null }, workspace: "C:\\w" });
assert.equal(local.kind, "local");
assert.equal(local.note, "no container runtime detected; local execution fallback");
if (process.platform === "win32") {
  assert.equal(local.command, "cmd.exe");
  assert.deepEqual(local.args, ["/d", "/s", "/c", "npm test"]);
} else {
  assert.equal(local.command, "/bin/sh");
  assert.deepEqual(local.args, ["-c", "npm test"]);
}

// 7. Empty command throws — verifying nothing is a caller bug.
assert.throws(() => buildIsolatedSpec("   ", { sandbox: { kind: "docker", version: null }, workspace: "C:\\w" }), /empty command/);
assert.throws(() => buildIsolatedSpec("", { sandbox: { kind: null, version: null }, workspace: "C:\\w" }), /empty command/);

// 8. winToPosix edges.
assert.equal(winToPosix("C:\\"), "/c/");
assert.equal(winToPosix("C:\\x\\y"), "/c/x/y");
assert.equal(winToPosix("D:/POSIX/Already"), "/d/POSIX/Already");
assert.equal(winToPosix("/srv/w"), "/srv/w");

// 9. readPolicy.
assert.deepEqual(readPolicy({}), { mode: "off" }); // unset → safe default
assert.deepEqual(readPolicy({ LOAM_SWARM_SANDBOX: "off" }), { mode: "off" });
assert.deepEqual(readPolicy({ LOAM_SWARM_SANDBOX: "bogus" }), { mode: "off" }); // unrecognized → off
assert.deepEqual(readPolicy({ LOAM_SWARM_SANDBOX: "auto" }), { mode: "auto" });
assert.deepEqual(readPolicy({ LOAM_SWARM_SANDBOX: "1" }), { mode: "auto" });
assert.deepEqual(
  readPolicy({ LOAM_SWARM_SANDBOX: "auto", LOAM_SWARM_SANDBOX_IMAGE: "node:20-alpine" }),
  { mode: "auto", image: "node:20-alpine" },
);

// 10. resolveExecution — auto + no runtime → graceful local fallback.
const graceful = await resolveExecution("npm test", {
  workspace: "C:\\w",
  env: { LOAM_SWARM_SANDBOX: "auto" },
  detect: async () => ({ kind: null, version: null }),
});
assert.equal(graceful.kind, "local");
assert.equal(graceful.note, "no container runtime detected; local execution fallback");

// auto + docker → sandboxed, and the policy image flows into the spec.
const resolved = await resolveExecution("npm test", {
  workspace: "C:\\users\\x\\work",
  env: { LOAM_SWARM_SANDBOX: "1", LOAM_SWARM_SANDBOX_IMAGE: "node:20-alpine" },
  detect: async () => ({ kind: "docker", version: "Docker version 24.0.7" }),
});
assert.equal(resolved.kind, "sandboxed");
assert.equal(resolved.command, "docker");
assert.equal(resolved.args[6], "node:20-alpine");
assert.equal(resolved.args[3], "/c/users/x/work:/work");

// off → local even when docker is present; off never probes.
let detectCalls = 0;
const offLocal = await resolveExecution("npm test", {
  workspace: "C:\\w",
  env: { LOAM_SWARM_SANDBOX: "off" },
  detect: async () => {
    detectCalls += 1;
    return { kind: "docker", version: "Docker version 24.0.7" };
  },
});
assert.equal(offLocal.kind, "local");
assert.equal(offLocal.command, process.platform === "win32" ? "cmd.exe" : "/bin/sh");
assert.equal(detectCalls, 0);

// A detector that throws must not break execution — degrade to local.
const throwing = await resolveExecution("npm test", {
  workspace: "C:\\w",
  env: { LOAM_SWARM_SANDBOX: "auto" },
  detect: async () => {
    throw new Error("probe exploded");
  },
});
assert.equal(throwing.kind, "local");

console.log("PASS swarm isolation");
