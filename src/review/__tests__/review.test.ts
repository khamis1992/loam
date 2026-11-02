import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { collectChangedFiles } from "../changedFiles.js";
import { detectRuntimes, runProbe } from "../probeRunner.js";
import { copyWorkspace, removeCopy } from "../sandboxCopy.js";
import { DatabaseSync } from "node:sqlite";
import { setRecallService } from "../../memory/recall/instance.js";
import { createRecallService } from "../../memory/recall/service.js";
import { DEFAULT_REVIEW_POLICY, harnessNote, modeFor, secondLook } from "../secondLook.js";
import { configureTurnHooks, maybeSecondLook } from "../turnHook.js";
import { parseVerdict, stripThink } from "../verdict.js";
import type { TextModel } from "../../memory/recall/types.js";
import type { OllamaClient } from "../../ollama.js";

describe("review.verdict", () => {
  it("parses LGTM, caps findings, and treats a missing verdict as an error", () => {
    assert.equal(stripThink("<think>secret</think>\nVERDICT: LGTM").includes("secret"), false);
    assert.deepEqual(parseVerdict("notes\nVERDICT: LGTM", 5, 2500), { status: "lgtm" });
    const findings = parseVerdict("1. one\n2. two\n3. three\n4. four\n5. five\n6. six\nVERDICT: FINDINGS", 5, 2500);
    assert.equal(findings.status, "findings");
    if (findings.status === "findings") assert.equal(findings.findings.length, 5);
    assert.equal(parseVerdict("looks fine", 5, 2500).status, "error");
  });
});

describe("review.changedFiles", () => {
  it("unions the ledger with mtime and lists binaries by name", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-changes-"));
    fs.writeFileSync(path.join(root, "note.txt"), "hello");
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "skip.txt"), "nope");
    const started = Date.now() - 1000;
    const files = collectChangedFiles({ workspace: root, turnStartedAt: started, ledger: [path.join(root, "note.txt")] });
    const note = files.find((file) => file.relPath === "note.txt");
    assert.equal(note?.source, "both");
    assert.equal(files.find((file) => file.relPath === "blob.bin")?.binary, true);
    assert.equal(files.some((file) => file.relPath.includes("skip")), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("review.sandbox", () => {
  it("keeps a sentinel in the real dependency folder and skips an oversized tree", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-copy-"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "sentinel.txt"), "keep");
    fs.writeFileSync(path.join(root, "app.txt"), "copy me");
    const copied = copyWorkspace(root, "case1", { maxFiles: 10, maxBytes: 1024 * 1024 });
    assert.ok(!("skipped" in copied));
    if ("skipped" in copied) return;
    assert.ok(copied.dir.includes("loam-review-"));
    assert.equal(fs.readFileSync(path.join(copied.dir, "app.txt"), "utf8"), "copy me");
    removeCopy(copied.dir);
    assert.equal(fs.existsSync(copied.dir), false);
    assert.equal(fs.readFileSync(path.join(root, "node_modules", "sentinel.txt"), "utf8"), "keep");
    fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(100));
    const skipped = copyWorkspace(root, "case2", { maxFiles: 1, maxBytes: 10 });
    assert.deepEqual(skipped, { skipped: "too_large" });
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("review.loop", () => {
  it("reviews once, skips sub-agents, and never throws on a bad model", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-loop-"));
    fs.writeFileSync(path.join(root, "a.ts"), "export const n = 1;\n");
    const good: TextModel = { async complete() { return { text: "1. quantity 0 crashes\nVERDICT: FINDINGS", promptTokens: 3, completionTokens: 2 }; } };
    const input = {
      runId: "run",
      mode: "build",
      workspace: root,
      requests: ["handle quantity 0"],
      reply: "done",
      turnStartedAt: Date.now() - 1000,
      touched: ["a.ts"],
      toolCalls: 1,
      depth: 0,
      aborted: false,
      alreadyReviewed: false,
    };
    const first = await secondLook(input, good, DEFAULT_REVIEW_POLICY);
    assert.equal(first.status, "findings");
    if (first.status === "findings") assert.match(harnessNote(first.findings), /second_look/);
    const second = await secondLook({ ...input, alreadyReviewed: true }, good, DEFAULT_REVIEW_POLICY);
    assert.deepEqual(second, { status: "skipped", reason: "already_reviewed" });
    const nested = await secondLook({ ...input, depth: 2, alreadyReviewed: false }, good, DEFAULT_REVIEW_POLICY);
    assert.deepEqual(nested, { status: "skipped", reason: "subagent" });
    const broken: TextModel = { async complete() { throw new Error("model down"); } };
    const failed = await secondLook(input, broken, DEFAULT_REVIEW_POLICY);
    assert.equal(failed.status, "error");
    assert.equal(modeFor(DEFAULT_REVIEW_POLICY, "legal"), "read");
    assert.equal(modeFor({ ...DEFAULT_REVIEW_POLICY, modes: { legal: "run" } }, "legal"), "read");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads a saved review mode before calling the model", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-review-mode-"));
    fs.writeFileSync(path.join(dir, "a.ts"), "export const n = 1;\n");
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-review-db-"));
    const service = createRecallService(new DatabaseSync(path.join(dbDir, "t.db")));
    service.repo.setSetting("reviewModes", JSON.stringify({ build: "off" }));
    setRecallService(service);
    let called = false;
    configureTurnHooks({
      model: { async complete() { called = true; return { text: "1. bug\nVERDICT: FINDINGS", promptTokens: 1, completionTokens: 1 }; } },
    });
    const note = await maybeSecondLook({
      runId: "run",
      workspace: dir,
      requests: ["edit a.ts"],
      reply: "done",
      turnStartedAt: Date.now() - 1000,
      touched: ["a.ts"],
      toolCalls: 1,
      depth: 0,
      aborted: false,
      alreadyReviewed: false,
      ollama: {} as OllamaClient,
      modelName: "local",
      mode: "build",
    });
    assert.equal(note, null);
    assert.equal(called, false);
    setRecallService(null);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* db lock */ }
  });
});

describe("review.probe", () => {
  it("offers detected runtimes and stops a probe at the timeout", async () => {
    const runtimes = detectRuntimes();
    assert.ok(runtimes.includes("node"));
    assert.equal(runtimes.includes("python" as "node"), false);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-probe-"));
    const result = await runProbe({ cwd: root, runtime: "node", source: "setTimeout(() => {}, 10000)", timeoutMs: 200 });
    assert.equal(result.timedOut, true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
