import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manus-recovery-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;
const legacy = {
  tasks: [{ id: "legacy", title: "قديم", prompt: "مرحبا", status: "done", createdAt: "2020", updatedAt: "2020", messages: [{ role: "user", content: "عربي", at: "2020" }], steps: [] }],
  projects: [{ id: "project", name: "مشروع", createdAt: "2020", updatedAt: "2020" }],
  schedules: [{ id: "schedule", prompt: "work", intervalSeconds: 60, enabled: true, nextRunAt: "2020" }],
};
const original = JSON.stringify(legacy);
fs.writeFileSync(path.join(tmp, "db.json"), original);
const db = await import("../server/db.js");
const store = await import("../server/sqliteStore.js");
const { ExecutionQueue } = await import("../server/executionQueue.js");
const { requiresReplayConfirmation } = await import("../server/recovery.js");
const control = await import("../server/runControl.js");
db.loadDb();
assert.equal(db.getTask("legacy")?.messages[0]?.content, "عربي");
assert.equal(db.listProjects().length, 1);
assert.equal(db.listSchedules().length, 1);
assert.equal(fs.readFileSync(path.join(tmp, "db.pre-sqlite.json"), "utf8"), original);
assert.equal(fs.readFileSync(path.join(tmp, "db.json"), "utf8"), original);
store.acquireRuntimeLease();
assert.throws(() => store.acquireRuntimeLease(), /Another runtime/);
const backup = store.backupDatabase();
assert.ok(fs.existsSync(backup));
assert.equal(store.backupDatabase(), backup);
store.releaseRuntimeLease();
db.closeDb(); db.loadDb();
assert.equal(db.listTasks().length, 1, "migration is idempotent");
for (let i = 0; i < 305; i++) db.createTask(`task ${i}`);
assert.equal(db.listTasks().length, 306, "old tasks are never silently pruned");
assert.throws(() => store.transaction(() => { db.createTask("rollback"); throw new Error("rollback"); }));
assert.equal(db.listTasks().length, 306, "failed transaction rolls back");
const task = db.createTask("resume me");
const run = { prompt: "resume me", effectivePrompt: "resume me", history: [], workspace: tmp, started: false, orchestrated: true };
db.queueTaskRun(task.id, run, false);
db.setTaskStatus(task.id, "running");
db.closeDb(); db.loadDb();
assert.equal(db.getTask(task.id)?.status, "running", "ordinary reopening does not alter state");
assert.ok(db.recoverInterruptedTasks() > 0);
assert.equal(db.getTask(task.id)?.status, "interrupted");
assert.equal(db.getSavedRun(task.id)?.prompt, "resume me");
assert.equal(requiresReplayConfirmation(run), false);
assert.equal(requiresReplayConfirmation({ ...run, started: true }), true);
db.queueTaskRun(task.id, run, true);
assert.equal(db.getTask(task.id)?.messages.length, 1, "resume does not duplicate user message");
db.completeTaskRun(task.id, "result", "test-model");
db.closeDb(); db.loadDb();
assert.equal(db.getTask(task.id)?.status, "done");
assert.equal(db.getTask(task.id)?.messages.at(-1)?.content, "result");
assert.equal(db.getSavedRun(task.id), undefined, "completion and checkpoint removal commit together");

// A process that exits without closing SQLite must leave committed writes recoverable.
const crash = spawnSync(process.execPath, ["-e", `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');db.prepare('INSERT INTO entities VALUES(?,?,?)').run('crash','committed',JSON.stringify({id:'committed',value:42}));db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO entities VALUES(?,?,?)').run('crash','uncommitted','{}');process.exit(9);`, path.join(tmp, "manus.db")]);
assert.equal(crash.status, 9);
assert.equal(store.getEntity<{ value: number }>("crash", "committed")?.value, 42);
assert.equal(store.getEntity("crash", "uncommitted"), undefined);
console.log("PASS SQLite migration, backup, retention, rollback, restart and crash recovery");

const queue = new ExecutionQueue();
let release!: () => void;
const blocker = new Promise<void>((resolve) => { release = resolve; });
const order: string[] = [];
const first = queue.enqueue("first", async () => { order.push("first-start"); await blocker; order.push("first-end"); });
const cancel = new AbortController();
const dropped = queue.enqueue("cancel", async () => { throw new Error("cancelled job executed"); }, cancel.signal);
const droppedCheck = assert.rejects(dropped, /cancelled/);
const failure = queue.enqueue("failure", async () => { order.push("failure"); throw new Error("expected"); });
const failureCheck = assert.rejects(failure, /expected/);
const last = queue.enqueue("last", async () => { order.push("last"); });
await assert.rejects(queue.enqueue("first", async () => {}), /already/);
cancel.abort();
assert.deepEqual(queue.snapshot().queued, ["failure", "last"]);
release();
await Promise.all([first, droppedCheck, failureCheck, last]);
assert.deepEqual(order, ["first-start", "first-end", "failure", "last"]);
control.createRunSignal("active");
control.createRunSignal("waiting", false);
const epoch = control.currentCancelEpoch();
control.cancelRunSignal("waiting");
assert.equal(control.currentCancelEpoch(), epoch, "cancelling queued task cannot stop active computer tool");
control.cancelRunSignal("active");
assert.equal(control.currentCancelEpoch(), epoch + 1);
control.clearRunSignal("active"); control.clearRunSignal("waiting");
queue.stop();
await assert.rejects(queue.enqueue("shutdown", async () => {}), /shutting down/);
console.log("PASS FIFO ownership, duplicate rejection, queued cancellation, failure release and shutdown");
db.closeDb();

// Invalid legacy data must fail visibly and remain untouched, not become an empty DB.
const malformed = path.join(tmp, "malformed"); fs.mkdirSync(malformed);
fs.writeFileSync(path.join(malformed, "db.json"), "{invalid");
const childCode = `import {loadDb} from ${JSON.stringify(new URL("../server/db.ts", import.meta.url).href)}; loadDb();`;
const invalid = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode], { env: { ...process.env, MANUS_LOCAL_DATA_DIR: malformed } });
assert.notEqual(invalid.status, 0);
assert.equal(fs.readFileSync(path.join(malformed, "db.json"), "utf8"), "{invalid");
console.log(`PASS invalid migration preserves source; all recovery checks passed (${tmp})`);
