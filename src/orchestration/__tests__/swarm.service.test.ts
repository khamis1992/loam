/** C11 service end to end with scripted workers over real git and a real coordination DB (S3, S4, S5). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OllamaClient } from "../../ollama.js";
import { RealSwarmService, RealSwarmError, type RealSwarmServiceOptions } from "../swarm/service.js";
import { NOOP_CORE_FACTORY } from "../swarm/corePort.js";
import { SPAN } from "../tracing/genai.js";
import { FORCED_WRITE_NUDGE } from "../swarm/prompt.js";
import type { WorkerCheckpoint } from "../../agent/checkpoint.js";
import { baseTools, doSubtask, factoryFor, recordingPort, scriptedExecutor, sh, swarmConfig, testHost, tmpDir, type TurnCtx } from "./swarmHelpers.js";

function service(root: string, executor: RealSwarmServiceOptions["executor"], over: Partial<RealSwarmServiceOptions> = {}) {
  const host = testHost(root);
  const svc = new RealSwarmService({
    cfg: swarmConfig(), ollama: new OllamaClient("http://127.0.0.1:11434"), tools: baseTools(), dataDir: root, executor, coreFactory: NOOP_CORE_FACTORY, host,
    tickMs: 25, testTiming: { activationStaggerMs: 0, idleNudgeMs: 60_000, retryBackoffMs: [1, 1, 1, 1] }, ...over,
  });
  return { svc, host };
}

const waitFor = async (pred: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const hang = (c: TurnCtx) => new Promise<void>((_, reject) => c.opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

test("AC-S3.1-3.4 three workers self-organise: distinct claims, three merges, quiescent completion, metrics from git", async () => {
  const root = tmpDir();
  const exec = scriptedExecutor(async (c) => {
    if (c.turn === 1) await doSubtask(c, `part-${c.worker}`, `${c.worker}.txt`, `${c.worker}\n`);
  });
  const { svc, host } = service(root, exec);
  const created = svc.create({ goal: "Write one file per worker", maxWorkers: 3 });
  assert.equal(created.status, "queued");
  const s = await svc.settled(created.id);
  assert.equal(s.status, "completed", s.error);
  assert.equal(s.completionReason, "quiescent");
  for (const w of ["w1", "w2", "w3"]) assert.equal(fs.readFileSync(path.join(s.workspace, `${w}.txt`), "utf8"), `${w}\n`);
  const gitMerges = Number(await sh(s.workspace, "git rev-list --first-parent --merges --count main"));
  assert.equal(s.metrics.mergesLanded, 3);
  assert.equal(s.metrics.mergesLanded, gitMerges);
  assert.equal(s.metrics.mainCommits, Number(await sh(s.workspace, "git rev-list --count main")));
  assert.equal(s.metrics.patchVerified, 3);
  assert.equal(s.metrics.claimsOpened, 3);
  assert.equal(s.metrics.claimsActive, 0, "patches closed their claims (U12)");
  assert.equal(s.merges.length, 3);
  assert.equal(s.usage.modelCalls, exec.steps.reduce((a, b) => a + b, 0), "modelCalls = sum of RunResult.steps");
  assert.equal(s.usage.promptTokens, exec.runs.length * 10);
  assert.ok(exec.runs.every((o) => o.model === "remote-model" && o.cfg.model === "remote-model"), "cloud model only");
  assert.equal(new Set(exec.runs.map((o) => o.cfg.workspace)).size, 3, "each worker runs in its own worktree");
  assert.ok(exec.runs.every((o) => o.cfg.policy?.allowOutsideWorkspaceRead === false));
  assert.ok(exec.runs.every((o) => !!o.systemOverride && o.systemOverride.includes(o.cfg.workspace ?? "?")), "worker system prompt names its own worktree");
  assert.ok(s.workers.every((w) => w.status === "completed"));
  assert.ok(!fs.existsSync(path.join(s.workspace, ".loam", "realswarm", "workers", "w1")), "worktrees removed at the end");
  assert.deepEqual(host.statuses.at(-1), [s.taskId, "completed"]);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, "realswarm", `${s.id}.json`), "utf8"));
  assert.equal(persisted.status, "completed");
  assert.match(svc.board(s.id).rendered, /evidence=cat w1\.txt passed/);
});

test("AC-S3.5 a worker that writes no gist gets exactly one forced-write turn, then goes idle", async () => {
  const root = tmpDir();
  const exec = scriptedExecutor(async (c) => {
    if (c.worker === "w1" && c.turn === 1) await doSubtask(c, "only", "only.txt", "x");
    // w2 never writes anything
  });
  const { svc } = service(root, exec);
  const s = await svc.settled(svc.create({ goal: "g", maxWorkers: 2 }).id);
  assert.equal(s.status, "completed", s.error);
  const w2 = exec.runs.filter((o) => o.sessionId?.endsWith("-w2-1") || o.sessionId?.endsWith("-w2-2"));
  assert.equal(w2.length, 2);
  assert.ok(!w2[0]!.prompt.includes(FORCED_WRITE_NUDGE));
  assert.ok(w2[1]!.prompt.includes(FORCED_WRITE_NUDGE), "second turn carries the forced-write nudge");
});

test("AC-S4.1 merge conflict: the worker is told mid-turn, resolves, and conflictsResolved counts the file", async () => {
  const root = tmpDir();
  let w1Merged!: () => void;
  const w1Done = new Promise<void>((r) => (w1Merged = r));
  const exec = scriptedExecutor(async (c) => {
    if (c.turn !== 1) return;
    if (c.worker === "w1") {
      await doSubtask(c, "header", "shared.txt", "w1\n");
      w1Merged();
      return;
    }
    await c.call("board_write", { type: "CLAIM", content: "footer", work_label: "footer" });
    await c.call("file_write", { path: "shared.txt", content: "w2\n" });
    await c.call("git_commit", { message: "w2 footer" });
    await w1Done;
    const m = await c.call("merge_request", { work_label: "footer" });
    assert.match(m.content, /^conflict: shared\.txt/);
    assert.match(m.content, /DM from harness/, "conflict note delivered mid-turn");
    await c.call("shell_run", { command: "git merge main >/dev/null 2>&1; printf 'w1\\nw2\\n' > shared.txt && git add -A && git commit -q -m resolve" });
    const again = await c.call("merge_request", { work_label: "footer" });
    assert.match(again.content, /^merged/);
    await c.call("board_write", { type: "PATCH_SUMMARY", content: "files=shared.txt | idea=footer | evidence=cat shared.txt passed", work_label: "footer" });
  });
  const { svc } = service(root, exec);
  const s = await svc.settled(svc.create({ goal: "g", maxWorkers: 2 }).id);
  assert.equal(s.status, "completed", s.error);
  assert.equal(fs.readFileSync(path.join(s.workspace, "shared.txt"), "utf8"), "w1\nw2\n");
  assert.equal(s.metrics.conflictsResolved, 1);
  assert.deepEqual(s.merges.find((m) => m.worker === "w2")?.conflictsResolved, ["shared.txt"]);
  assert.equal(s.metrics.mergesLanded, 2, "the worker's own merge-main commit is not a landed merge");
  assert.ok(!exec.runs.some((o) => /conflict/i.test(o.prompt) && o.sessionId?.includes("-w2-")), "resolved conflict note is superseded, no stale turn");
});

test("AC-S4.2 a failing worker is retried with backoff and then dropped; the others finish", async () => {
  const root = tmpDir();
  const exec = scriptedExecutor(async (c) => {
    if (c.worker === "w2") throw new Error("provider 500");
    if (c.turn === 1) await doSubtask(c, "ok", "ok.txt", "x");
  });
  const { svc } = service(root, exec);
  const s = await svc.settled(svc.create({ goal: "g", maxWorkers: 2 }).id);
  assert.equal(s.status, "completed", s.error);
  const w2 = s.workers.find((w) => w.id === "w2")!;
  assert.equal(w2.status, "failed");
  assert.equal(w2.attempts, 5);
  assert.ok(s.events.some((e) => e.type === "worker_failed" && e.worker === "w2"));
});

test("AC-S4.3 all workers failing fails the run", async () => {
  const root = tmpDir();
  const { svc } = service(root, scriptedExecutor(async () => {
    throw new Error("down");
  }));
  const s = await svc.settled(svc.create({ goal: "g", maxWorkers: 2 }).id);
  assert.equal(s.status, "failed");
  assert.equal(s.completionReason, "all_workers_failed");
});

test("AC-S4.4 cancel stops every worker", async () => {
  const root = tmpDir();
  const exec = scriptedExecutor(hang);
  const { svc } = service(root, exec);
  const id = svc.create({ goal: "g", maxWorkers: 2 }).id;
  await waitFor(() => exec.runs.length === 2);
  svc.cancel(id);
  const s = await svc.settled(id);
  assert.equal(s.status, "cancelled");
  assert.ok(s.workers.every((w) => w.status === "cancelled"));
});

test("AC-S4.5 shutdown marks interrupted; restart keeps it; resume needs C2 (409); retry reuses the board and repo", async () => {
  const root = tmpDir();
  const first = scriptedExecutor(async (c) => {
    await c.call("board_write", { type: "FACT", content: "lesson from the first attempt" });
    await hang(c);
  });
  const a = service(root, first);
  const id = a.svc.create({ goal: "g", maxWorkers: 1 }).id;
  await waitFor(() => first.runs.length === 1);
  await new Promise((r) => setTimeout(r, 50));
  await a.svc.close();
  assert.equal(a.svc.get(id).status, "interrupted");
  assert.throws(() => a.svc.create({ goal: "g" }), (e: unknown) => e instanceof RealSwarmError && e.status === 409);

  const second = scriptedExecutor(async (c) => {
    if (c.turn === 1) {
      assert.match(c.opts.prompt, /lesson from the first attempt/, "retry sees the old board");
      await doSubtask(c, "after-retry", "r.txt", "x");
    }
  });
  const b = service(root, second);
  assert.equal(b.svc.get(id).status, "interrupted");
  assert.throws(() => b.svc.resume(id), (e: unknown) => e instanceof RealSwarmError && e.status === 409 && /C2/.test(e.message));
  b.svc.retry(id);
  const s = await b.svc.settled(id);
  assert.equal(s.status, "completed", s.error);
  assert.ok(fs.existsSync(path.join(s.workspace, "r.txt")));
});

test("interrupted-on-restart: a snapshot left running is loaded as interrupted", () => {
  const root = tmpDir();
  const id = "realswarm_00000000-0000-4000-8000-000000000000";
  fs.mkdirSync(path.join(root, "realswarm"), { recursive: true });
  fs.writeFileSync(path.join(root, "realswarm", `${id}.json`), JSON.stringify({ id, taskId: "t1", workspace: root, status: "running", workers: [{ id: "w1", status: "running" }], events: [], merges: [] }));
  fs.writeFileSync(path.join(root, "realswarm", "realswarm_bad.json"), "{");
  const { svc, host } = service(root, scriptedExecutor(async () => undefined));
  const s = svc.get(id);
  assert.equal(s.status, "interrupted");
  assert.equal(s.workers[0]!.status, "interrupted");
  assert.deepEqual(host.statuses, [["t1", "interrupted"]]);
});

test("AC-S5.1 resume restores each worker from its latest C2 checkpoint", async () => {
  const root = tmpDir();
  const port = recordingPort();
  const cp: WorkerCheckpoint = { prompt: "p", messages: [{ role: "user", content: "half done" }], trace: [], steps: 3, model: "remote-model", usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  const first = scriptedExecutor(async (c) => {
    c.opts.saveWorker?.(cp);
    await hang(c);
  });
  const a = service(root, first, { coreFactory: factoryFor(port) });
  const id = a.svc.create({ goal: "g", maxWorkers: 1 }).id;
  await waitFor(() => port.saved.size === 1);
  await a.svc.close();
  const key = [...port.saved.keys()][0]!;
  assert.equal(key, `realswarm/${id}/w1`);
  assert.equal(port.saved.get(key)!.rev, 1);

  let restored: WorkerCheckpoint | undefined;
  const second = scriptedExecutor(async (c) => {
    if (c.turn === 1) {
      restored = c.opts.resumeWorker;
      await doSubtask(c, "resumed", "z.txt", "x");
    } else assert.equal(c.opts.resumeWorker, undefined, "only the first turn resumes");
  });
  const b = service(root, second, { coreFactory: factoryFor(port) });
  b.svc.resume(id);
  const s = await b.svc.settled(id);
  assert.equal(s.status, "completed", s.error);
  assert.deepEqual(restored, cp);
  // the resumed turn reported steps = its own calls + 1; cp.steps (3) restored steps are not new model calls
  const total = second.steps.reduce((a, b) => a + b, 0);
  assert.equal(s.usage.modelCalls, Math.max(0, second.steps[0]! - cp.steps) + (total - second.steps[0]!));
});

test("AC-S5.2 tracing: one run span, worker spans, turn, tool and merge spans, all ended", async () => {
  const root = tmpDir();
  const port = recordingPort();
  const exec = scriptedExecutor(async (c) => {
    if (c.turn === 1) await doSubtask(c, `t-${c.worker}`, `${c.worker}.txt`, "x");
  });
  const { svc } = service(root, exec, { coreFactory: factoryFor(port) });
  const s = await svc.settled(svc.create({ goal: "g", maxWorkers: 2 }).id);
  assert.equal(s.status, "completed", s.error);
  assert.equal(s.traceId, "trace-test");
  assert.deepEqual(s.shared, { progress: false, checkpoints: true, selection: false, tracing: true });
  const by = (n: string) => port.spans.filter((x) => x.name === n);
  assert.equal(by(SPAN.swarmRun).length, 1);
  assert.equal(by(SPAN.swarmWorker).length, 2);
  assert.equal(by(SPAN.swarmMerge).length, 2);
  assert.equal(by(SPAN.swarmTurn).length, exec.runs.length);
  assert.ok(by(SPAN.toolCall).length >= 10);
  assert.ok(port.spans.every((x) => x.ended), "no span left open");
  assert.equal(by(SPAN.swarmRun)[0]!.attrs["loam.swarm.merges"], 2);
});

test("AC-S5.3 idle nudge after idleNudgeMs carries the C1 progress reason; never sent once the goal is met", async () => {
  const root = tmpDir();
  const judged: string[] = [];
  const port = recordingPort({
    progress: {
      async judgeProgress(i) {
        judged.push(i.workerId);
        return { isInLoop: false, isProgressBeingMade: false, reason: "no file has been written yet" };
      },
    },
  });
  const exec = scriptedExecutor(async (c) => {
    if (c.turn === 1) await c.call("board_write", { type: "FACT", content: "looked around, repo is empty" });
    else if (/no file has been written yet/.test(c.opts.prompt)) await doSubtask(c, "nudged", "n.txt", "x");
  });
  const { svc } = service(root, exec, { coreFactory: factoryFor(port), testTiming: { activationStaggerMs: 0, idleNudgeMs: 150, retryBackoffMs: [1] } });
  const s = await svc.settled(svc.create({ goal: "g", maxWorkers: 1 }).id);
  assert.equal(s.status, "completed", s.error);
  assert.deepEqual(judged, ["w1"]);
  assert.equal(s.events.filter((e) => e.type === "idle_nudge").length, 1);
});

test("AC-S5.4 competing verified patches on one label go through C3 selection when it is on (OD-14)", async () => {
  const root = tmpDir();
  const port = recordingPort({
    selection: {
      async selectBest(i) {
        assert.equal(i.candidates.length, 2);
        assert.ok(i.candidates.every((c) => (c.diff ?? "").includes("+")));
        return { chosenBranch: "worker/w1/fix", method: "judge", reason: "smaller diff" };
      },
    },
  });
  let posted = 0;
  let bothPosted!: () => void;
  const barrier = new Promise<void>((r) => (bothPosted = r));
  const results: Record<string, string> = {};
  const exec = scriptedExecutor(async (c) => {
    if (c.turn !== 1) return;
    await c.call("board_write", { type: "CLAIM", content: `fix bug ${c.worker}`, work_label: "fix" });
    await c.call("file_write", { path: `${c.worker}.txt`, content: c.worker });
    await c.call("git_commit", { message: c.worker });
    await c.call("board_write", { type: "PATCH_SUMMARY", content: `files=${c.worker}.txt | idea=fix | evidence=npm test passed`, work_label: "fix" });
    if (++posted === 2) bothPosted();
    await barrier;
    if (c.worker === "w1") await new Promise((r) => setTimeout(r, 100));
    results[c.worker] = (await c.call("merge_request", { work_label: "fix" })).content;
  });
  const { svc } = service(root, exec, { coreFactory: factoryFor(port) });
  const s = await svc.settled(svc.create({ goal: "g", maxWorkers: 2 }).id);
  assert.equal(s.status, "completed", s.error);
  assert.match(results.w2!, /nothing to merge/);
  assert.match(results.w1!, /^merged/);
  assert.ok(fs.existsSync(path.join(s.workspace, "w1.txt")));
  assert.ok(!fs.existsSync(path.join(s.workspace, "w2.txt")));
  assert.ok(s.events.some((e) => e.type === "selection"));
});

test("cloud models only: the local model and a localhost endpoint are rejected at create()", () => {
  const root = tmpDir();
  const { svc } = service(root, scriptedExecutor(async () => undefined));
  for (const model of ["qwen3:8b", "lan-model"]) {
    assert.throws(() => svc.create({ goal: "g", model }), (e: unknown) => e instanceof RealSwarmError && e.status === 400 && /cloud/.test(e.message));
  }
  const local = service(tmpDir(), scriptedExecutor(async () => undefined), { cfg: { ...swarmConfig(), model: "qwen3:8b" } });
  assert.throws(() => local.svc.create({ goal: "g" }), /cloud/);
  assert.equal(svc.list().length, 0, "nothing is created");
});

test("input validation, switch-off and the active-run cap", async () => {
  const root = tmpDir();
  const exec = scriptedExecutor(hang);
  const { svc } = service(root, exec);
  assert.throws(() => svc.create({ goal: "" }), RealSwarmError);
  assert.throws(() => svc.create({ goal: "g", maxWorkers: 17 }), /maxWorkers/);
  assert.throws(() => svc.create({ goal: "g", repoSeed: path.join(root, "missing") }), /repoSeed/);
  assert.throws(() => svc.get("nope"), /Invalid run id/);
  const a = svc.create({ goal: "g", maxWorkers: 1 }).id;
  const b = svc.create({ goal: "g", maxWorkers: 1 }).id;
  assert.throws(() => svc.create({ goal: "g" }), (e: unknown) => e instanceof RealSwarmError && e.status === 409);
  assert.equal(svc.get(b).status, "queued", "one lane: the second run waits");
  svc.cancel(a);
  svc.cancel(b);
  await Promise.all([svc.settled(a), svc.settled(b)]);
  const cfg = swarmConfig();
  cfg.orchestration!.swarm.enabled = false;
  const off = service(tmpDir(), exec, { cfg });
  assert.throws(() => off.svc.create({ goal: "g" }), /turned off/);
});
