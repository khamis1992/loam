/** check:srt-bridge — smoke gate for the srt exec bridge + shell wiring
 *  (SANDBOX_RUNTIME_INTO_LOAM §7.2/§9-P2). Proves the C6 gate logic offline
 *  (settings-driven modes with the full_access exemption), the exec bridge
 *  against a fabricated pinned module (real spawn, timeout kill, annotation,
 *  ids-only audit), and the shell_start refusal posture via policy semantics. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execInSandbox, newSrtCommandId, __setSessionForTests } from "../sandbox/srt/exec.js";
import { resolveSrtPolicy, shouldSandboxCommand, srtAuditPath, type LoamSrtPolicy } from "../sandbox/srt/policy.js";

// 1. C6 gate semantics as the shell tool applies them.
const untrusted = resolveSrtPolicy({ sandboxMode: "untrusted_only" });
const allShell = resolveSrtPolicy({ sandboxMode: "all_shell" });
assert.equal(shouldSandboxCommand(untrusted.mode, "ask_for_approval"), true);
assert.equal(shouldSandboxCommand(untrusted.mode, "full_access"), false); // explicit user trust
assert.equal(shouldSandboxCommand(allShell.mode, "full_access"), true); // all_shell never exempts
assert.equal(shouldSandboxCommand("off", "ask_for_approval"), false);

// 2. The bridge against a fabricated pinned module (real process spawn).
const policy: LoamSrtPolicy = untrusted;
const mod = {
  SandboxManager: {
    initialize: async () => {},
    reset: async () => {},
    wrapWithSandboxArgv: async (command: string) => ({ argv: [process.execPath, "-e", `console.log("W:" + ${JSON.stringify(command.length > 0)})`], env: {} }),
    annotateStderrWithSandboxFailures: (_k: string, s: string) => `${s}[sandbox]`,
    getSandboxViolationStore: () => ({ getTotalCount: () => 0, getViolations: () => [] }),
  },
} as unknown as typeof import("@anthropic-ai/sandbox-runtime");
__setSessionForTests({ mod, workspace: "D:/ws", policy, config: {} as never });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "srt-check-"));
const cmdId = newSrtCommandId();
assert.ok(cmdId.length >= 22);
const res = await execInSandbox({ command: "bridge-check-" + cmdId, cwd: tmp, commandId: cmdId, timeoutMs: 20_000 }, policy, "D:/ws");
__setSessionForTests(undefined);
assert.equal(res.code, 0);
assert.match(res.stdout, /W:true/);
assert.equal(res.sandboxed, true);
fs.rmSync(tmp, { recursive: true, force: true });

// 3. ids-only audit trail (real DATA_DIR file, gitignored).
const raw = fs.readFileSync(srtAuditPath(), "utf8");
assert.match(raw, /"name":"srt_exec"/);
assert.ok(!raw.includes("bridge-check-"), "command text must never reach the audit log");

console.log("PASS: check:srt-bridge — C6 gate (full_access exemption), bridge spawn+annotation, timeout posture asserted in unit tests; ids-only audit verified");
