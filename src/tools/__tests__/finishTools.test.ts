/**
 * Unit tests for the `think` and `finish` tools (finishTools.ts).
 *
 * Covers the required invariants:
 *  - `think` returns "noted" and emits no assistant (or any) event
 *  - `finish` rejects missing or workspace-escaping proof paths
 *  - `finish` runs .loam/verify.json gates and blocks `done` when one fails
 *  - `finish` emits `done` and reports gates when they pass
 *  - `finish` emits `done` when no verify.json exists
 *
 * Gates are exercised through an injected runner; no real shell is spawned.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createFinishTools, type GateResult } from "../finishTools.js";
import type { AgentEvent } from "../../agent/events.js";
import type { Tool, ToolContext } from "../registry.js";

let tmpDir = "";
let outsideDir = "";

const makeCtx = (emit: (e: AgentEvent) => void): ToolContext => ({
  cfg: { model: "test-model" } as never,
  workspace: tmpDir,
  emit,
});

const tool = (name: string, runGate?: (cmd: string, opts: { cwd: string; timeoutMs: number }) => Promise<GateResult>): Tool =>
  createFinishTools(runGate ? { runGate } : {}).find((t) => t.name === name)!;

const parse = (content: string): Record<string, unknown> => JSON.parse(content) as Record<string, unknown>;

function writeVerify(workspace: string, value: unknown): void {
  const dir = path.join(workspace, ".loam");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "verify.json"), JSON.stringify(value), "utf8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-finish-"));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-finish-outside-"));
});

afterEach(() => {
  for (const dir of [tmpDir, outsideDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("think", () => {
  it("returns 'noted' and emits no event (no assistant message)", async () => {
    const events: AgentEvent[] = [];
    const res = await tool("think").run({ note: "plan the next step" }, makeCtx((e) => events.push(e)));
    assert.equal(res.ok, true);
    assert.equal(res.content, "noted");
    assert.deepEqual(events, []);
  });

  it("rejects an empty or oversized note", async () => {
    const events: AgentEvent[] = [];
    const ctx = makeCtx((e) => events.push(e));
    const empty = await tool("think").run({ note: "   " }, ctx);
    assert.equal(empty.ok, false);
    const long = await tool("think").run({ note: "x".repeat(8001) }, ctx);
    assert.equal(long.ok, false);
    assert.deepEqual(events, []);
  });
});

describe("finish proof validation", () => {
  it("rejects a proof path that does not exist and emits nothing", async () => {
    const events: AgentEvent[] = [];
    const res = await tool("finish").run(
      { summary: "done", confidence: "high", proof: ["src/missing.ts"] },
      makeCtx((e) => events.push(e)),
    );
    assert.equal(res.ok, false);
    assert.match(res.content, /src\/missing\.ts/);
    assert.match(res.content, /not found/);
    assert.deepEqual(events, []);
  });

  it("rejects a proof path that escapes the workspace", async () => {
    const events: AgentEvent[] = [];
    const res = await tool("finish").run(
      { summary: "done", confidence: "high", proof: ["../../escape.txt", outsideDir] },
      makeCtx((e) => events.push(e)),
    );
    assert.equal(res.ok, false);
    assert.match(res.content, /escapes workspace/);
    assert.deepEqual(events, []);
  });

  it("rejects an invalid confidence and an empty summary", async () => {
    const events: AgentEvent[] = [];
    const ctx = makeCtx((e) => events.push(e));
    const badConfidence = await tool("finish").run({ summary: "s", confidence: "certain" }, ctx);
    assert.equal(badConfidence.ok, false);
    const noSummary = await tool("finish").run({ summary: "  ", confidence: "high" }, ctx);
    assert.equal(noSummary.ok, false);
    assert.deepEqual(events, []);
  });
});

describe("finish verification gate", () => {
  it("blocks done when a gate fails and returns the failing output", async () => {
    const events: AgentEvent[] = [];
    writeVerify(tmpDir, {
      commands: [
        { name: "typecheck", cmd: "npx tsc --noEmit" },
        { name: "tests", cmd: "node --test" },
      ],
    });
    const seen: string[] = [];
    const runGate = async (cmd: string): Promise<GateResult> => {
      seen.push(cmd);
      return cmd.includes("tsc") ? { code: 1, output: "error TS2322: boom" } : { code: 0, output: "ok" };
    };

    const res = await tool("finish", runGate).run(
      { summary: "done", confidence: "high" },
      makeCtx((e) => events.push(e)),
    );
    assert.equal(res.ok, false);
    assert.match(res.content, /typecheck/);
    assert.match(res.content, /exit 1/);
    assert.match(res.content, /error TS2322/);
    assert.deepEqual(events, [], "done must not be emitted when a gate fails");
    assert.deepEqual(seen, ["npx tsc --noEmit"], "stops at the first failing gate");
  });

  it("emits done and reports gates passed, proof and confidence", async () => {
    const events: AgentEvent[] = [];
    writeVerify(tmpDir, {
      commands: [
        { name: "typecheck", cmd: "npx tsc --noEmit", cwd: "." },
        { name: "build", cmd: "npm run build:server", cwd: "packages/web" },
      ],
      timeoutSec: 120,
    });
    const proofFile = path.join(tmpDir, "src", "a.ts");
    fs.mkdirSync(path.dirname(proofFile), { recursive: true });
    fs.writeFileSync(proofFile, "export {};\n", "utf8");

    const seen: Array<{ cmd: string; cwd: string; timeoutMs: number }> = [];
    const runGate = async (cmd: string, opts: { cwd: string; timeoutMs: number }): Promise<GateResult> => {
      seen.push({ cmd, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
      return { code: 0, output: "ok" };
    };

    const res = await tool("finish", runGate).run(
      { summary: "shipped", confidence: "medium", proof: ["src/a.ts"], followups: ["write docs"] },
      makeCtx((e) => events.push(e)),
    );
    assert.equal(res.ok, true);

    const done = events.find((e) => e.type === "done");
    assert.ok(done && done.type === "done", "done event emitted");
    assert.equal(done.text, "shipped");
    assert.equal(done.model, "test-model");

    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.cmd, "npx tsc --noEmit");
    assert.equal(seen[0]!.cwd, tmpDir);
    assert.equal(seen[0]!.timeoutMs, 120_000);
    assert.equal(seen[1]!.cwd, path.join(tmpDir, "packages", "web"));

    const report = parse(res.content);
    assert.equal(report.gatesPassed, 2);
    assert.deepEqual(report.proof, ["src/a.ts"]);
    assert.equal(report.confidence, "medium");
    assert.deepEqual(report.followups, ["write docs"]);
  });

  it("emits done when no verify.json exists", async () => {
    const events: AgentEvent[] = [];
    const res = await tool("finish").run({ summary: "done", confidence: "low" }, makeCtx((e) => events.push(e)));
    assert.equal(res.ok, true);
    assert.equal(events.filter((e) => e.type === "done").length, 1);
    assert.equal(parse(res.content).gatesPassed, 0);
  });

  it("rejects a gate cwd that escapes the workspace", async () => {
    const events: AgentEvent[] = [];
    writeVerify(tmpDir, { commands: [{ name: "evil", cmd: "echo hi", cwd: "../outside" }] });
    const runGate = async (): Promise<GateResult> => ({ code: 0, output: "ok" });
    const res = await tool("finish", runGate).run(
      { summary: "done", confidence: "high" },
      makeCtx((e) => events.push(e)),
    );
    assert.equal(res.ok, false);
    assert.match(res.content, /escapes workspace/);
    assert.deepEqual(events, []);
  });

  it("rejects a malformed verify.json without emitting done", async () => {
    const events: AgentEvent[] = [];
    const dir = path.join(tmpDir, ".loam");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "verify.json"), "{ not json", "utf8");
    const res = await tool("finish").run({ summary: "done", confidence: "high" }, makeCtx((e) => events.push(e)));
    assert.equal(res.ok, false);
    assert.match(res.content, /verify\.json/);
    assert.deepEqual(events, []);
  });
});
