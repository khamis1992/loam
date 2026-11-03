import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execInSandbox, newSrtCommandId, __setSessionForTests } from "../exec.js";
import { srtAuditPath } from "../policy.js";
import type { LoamSrtPolicy } from "../policy.js";

/** Fabricated pinned module: wrapWithSandboxArgv rewrites any command into a real
 *  `node -e <script>` spawn so the exec bridge's process handling, timeout, audit
 *  and annotation paths are exercised for real — only the ASRT wrapping is mocked.
 *  `violationsDelta` simulates sandbox violations observed while the command runs. */
function fabricateModule(scriptOf: (command: string) => string, violationsDelta = 0) {
  let total = 0;
  return {
    SandboxManager: {
      initialize: async () => {},
      reset: async () => {},
      wrapWithSandboxArgv: async (command: string) => {
        total += violationsDelta; // violations accrue while the wrapped command runs
        return { argv: [process.execPath, "-e", scriptOf(command)], env: {} };
      },
      annotateStderrWithSandboxFailures: (_key: string, stderr: string) => `${stderr}[sandbox: violation annotated]`,
      getSandboxViolationStore: () => ({ getTotalCount: () => total, getViolations: () => [] }),
    },
  } as unknown as typeof import("@anthropic-ai/sandbox-runtime");
}

const policy: LoamSrtPolicy = {
  mode: "all_shell", strictAllowlist: true, allowedDomains: [],
  denyRead: ["~/.ssh"], allowRead: ["."], allowWrite: ["."], denyWrite: [".env"],
  allowLocalBinding: false, timeoutMs: 30_000,
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "srt-exec-"));
// The audit singleton binds to the real DATA_DIR at module load; assertions read
// the same file via the policy helper (gitignored data/srt/audit.jsonl).

test("execInSandbox: runs the wrapped argv, annotates stderr, audits ids-only", async (t) => {
  const mod = fabricateModule((c) => `console.log("ran:" + ${JSON.stringify(c.includes("echo"))}); console.error("noise");`);
  __setSessionForTests({ mod, workspace: "D:/ws", policy, config: {} as never });
  t.after(() => __setSessionForTests(undefined));
  const id = newSrtCommandId();
  assert.ok(id.length >= 22);
  const res = await execInSandbox({ command: "echo hi", cwd: dataDir, commandId: id, timeoutMs: 15_000 }, policy, "D:/ws");
  assert.equal(res.sandboxed, true);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /ran:true/);
  assert.match(res.annotatedStderr, /\[sandbox: violation annotated\]/);
  assert.equal(res.commandId, id);
  // Audit landed with ids only — command text never recorded.
  const raw = fs.readFileSync(srtAuditPath(), "utf8");
  assert.match(raw, /"name":"srt_exec"/);
  assert.ok(!raw.includes("echo hi"), "command text must never reach the audit log");
});

test("execInSandbox: non-zero exit and violation count flow through", async (t) => {
  const mod = fabricateModule(() => "console.error('boom'); process.exit(3);", 2);
  __setSessionForTests({ mod, workspace: "D:/ws", policy, config: {} as never });
  t.after(() => __setSessionForTests(undefined));
  const res = await execInSandbox({ command: "failing-" + Date.now(), cwd: dataDir, timeoutMs: 15_000 }, policy, "D:/ws");
  assert.equal(res.code, 3);
  assert.equal(res.violationCount, 2);
  const raw = fs.readFileSync(srtAuditPath(), "utf8");
  assert.match(raw, /"name":"srt_violation"/);
  assert.match(raw, /"violationCount":2/);
});

test("execInSandbox: timeout kills the tree and reports timedOut", async (t) => {
  const mod = fabricateModule(() => "setTimeout(()=>{}, 60000); console.log('alive')");
  __setSessionForTests({ mod, workspace: "D:/ws", policy, config: {} as never });
  t.after(() => __setSessionForTests(undefined));
  const res = await execInSandbox({ command: "hang-" + Date.now(), cwd: dataDir, timeoutMs: 2_500 }, policy, "D:/ws");
  assert.equal(res.timedOut, true);
  assert.notEqual(res.code, 0);
  const raw = fs.readFileSync(srtAuditPath(), "utf8");
  assert.match(raw, /"timedOut":true/);
});
