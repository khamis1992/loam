/**
 * Tests for the shell approval-gate seam: `src/tools/shell.ts` wiring of the
 * jcode blast-radius classifier (`src/policy/commandRisk`).
 *
 * Guarantees under test:
 *  - a Catastrophic target is refused outright and cannot be confirmed
 *  - an unresolvable (variable/glob) target escalates to "requires approval"
 *  - routine commands and destructive commands inside the workspace still run
 *  - the pre-existing substring denylist still applies (the gate is a union)
 *  - vault references are never inlined into the command
 *  - the same three tiers are enforced on a live `shell_write` session
 *
 * The home directory is redirected to a throwaway temp dir BEFORE the shell
 * module is imported, so `$HOME`-relative assertions are hermetic and never
 * touch the real user profile.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

interface ShellTool {
  name: string;
  run: (args: Record<string, unknown>, ctx: unknown) => Promise<{ ok: boolean; content: string }>;
}
interface ShellApi {
  shellTools: ShellTool[];
  disposeShellSessions: () => void;
}

const WIN = process.platform === "win32";

let shell: ShellApi;
let workspace = "";
let home = "";
let prevHome: string | undefined;
let prevProfile: string | undefined;

function ctx(workspaceDir: string, deny: string[] = []): unknown {
  return {
    cfg: { policy: { denyCommandPatterns: deny, allowCommandPatterns: [], maxCommandSeconds: 180 } },
    workspace: workspaceDir,
    agentId: "agent_test",
    emit: () => {},
  };
}

const tool = (name: string): ShellTool => shell.shellTools.find((t) => t.name === name)!;
const isBlocked = (content: string): boolean => /blocked by policy/.test(content);
const needsApproval = (content: string): boolean => /requires approval/.test(content);

describe("shell approval-gate seam (blast-radius classifier)", () => {
  before(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-shellrisk-ws-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "loam-shellrisk-home-"));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    shell = (await import("../shell.js")) as unknown as ShellApi;
  });

  after(() => {
    shell.disposeShellSessions();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    for (const dir of [workspace, home]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("refuses a catastrophic target outright", async () => {
    const res = await tool("shell_run").run({ command: "rm -rf /" }, ctx(workspace));
    assert.equal(res.ok, false);
    assert.ok(isBlocked(res.content), res.content);
    assert.match(res.content, /cannot be confirmed/);
  });

  it("refuses a catastrophic device-node write", async () => {
    const res = await tool("shell_run").run({ command: "dd if=/dev/zero of=/tmp/x.img" }, ctx(workspace));
    assert.equal(res.ok, false);
    assert.ok(isBlocked(res.content), res.content);
  });

  it("refuses a destructive command targeting the home directory", async () => {
    const res = await tool("shell_run").run({ command: "rm -rf $HOME" }, ctx(workspace));
    assert.equal(res.ok, false);
    assert.ok(isBlocked(res.content), res.content);
  });

  it("escalates an unresolvable target to approval", async () => {
    const res = await tool("shell_run").run({ command: "rm -rf $TARGET" }, ctx(workspace));
    assert.equal(res.ok, false);
    assert.ok(needsApproval(res.content), res.content);
    assert.ok(!isBlocked(res.content), "a Confirm verdict is approvable, not an absolute deny");
  });

  it("still runs a routine command", async () => {
    const res = await tool("shell_run").run({ command: "echo seam-ok" }, ctx(workspace));
    assert.equal(res.ok, true, res.content);
    assert.match(res.content, /seam-ok/);
  });

  it("still runs a destructive command inside the workspace", async () => {
    fs.mkdirSync(path.join(workspace, "scratch"));
    fs.writeFileSync(path.join(workspace, "scratch", "f.txt"), "x");
    const command = WIN ? "rmdir /s /q scratch" : "rm -rf scratch";
    const res = await tool("shell_run").run({ command }, ctx(workspace));
    assert.equal(res.ok, true, res.content);
    assert.ok(!isBlocked(res.content) && !needsApproval(res.content), res.content);
    assert.equal(fs.existsSync(path.join(workspace, "scratch")), false);
  });

  it("still applies the substring denylist (the gate is a union)", async () => {
    const res = await tool("shell_run").run({ command: "echo blocked-marker" }, ctx(workspace, ["blocked-marker"]));
    assert.equal(res.ok, false);
    assert.match(res.content, /denied command pattern/);
  });

  it("never inlines a vault reference into the command", async () => {
    const res = await tool("shell_run").run({ command: "echo {{vault:MISSING}}" }, ctx(workspace));
    assert.equal(res.ok, false);
    assert.match(res.content, /vault:.*MISSING/);
  });

  describe("live session (shell_write)", () => {
    let sessionId = "";

    before(async () => {
      const res = await tool("shell_start").run({ shell: WIN ? "cmd" : "sh", cwd: workspace }, ctx(workspace));
      assert.equal(res.ok, true, res.content);
      sessionId = res.content.match(/(shell_[0-9a-f]+)/)?.[1] ?? "";
      assert.ok(sessionId, `could not parse session id from: ${res.content}`);
    });

    after(() => {
      shell.disposeShellSessions();
    });

    it("allows a routine command", async () => {
      const res = await tool("shell_write").run({ id: sessionId, input: "echo session-ok" }, ctx(workspace));
      assert.equal(res.ok, true, res.content);
      assert.match(res.content, /sent to/);
    });

    it("refuses a catastrophic target", async () => {
      const res = await tool("shell_write").run({ id: sessionId, input: "rm -rf /" }, ctx(workspace));
      assert.equal(res.ok, false);
      assert.ok(isBlocked(res.content), res.content);
    });

    it("escalates an unresolvable target to approval", async () => {
      const res = await tool("shell_write").run({ id: sessionId, input: "rm -rf $TARGET" }, ctx(workspace));
      assert.equal(res.ok, false);
      assert.ok(needsApproval(res.content), res.content);
    });
  });
});
