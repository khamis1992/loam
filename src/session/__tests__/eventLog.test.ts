import { after, test } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";

// Must come before any import that evaluates `config.js`: this test writes event
// logs straight into `DATA_DIR/sessions`, so without this redirect it leaves
// residue in the repository's real `data/` folder.
import { cleanupIsolatedDataDir } from "../../test/isolation.js";

after(() => {
  cleanupIsolatedDataDir();
});

import {
  EventLog,
  ContiguityError,
  MigrationChainError,
  compileMigrationChain,
  defineMigration,
  foldProjections,
  getProjection,
  readLog,
  registerProjection,
  CURRENT_FORMAT_VERSION,
  type LogEvent,
  type Migration,
} from "../eventLog.js";
import { DATA_DIR } from "../../config.js";

let counter = 0;
function uniqueTaskId(prefix = "t"): string {
  counter += 1;
  return `${prefix}-${process.pid}-${counter}`;
}

function sessionDir(taskId: string): string {
  return path.join(DATA_DIR, "sessions", taskId);
}

async function cleanup(taskId: string): Promise<void> {
  await fs.rm(sessionDir(taskId), { recursive: true, force: true });
}

function makeEvent(seq: number, type = "e", data: unknown = {}): LogEvent {
  return { seq, ts: 1000 + seq, type, data };
}

function eventsToFile(events: LogEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
}

async function writeRawLog(taskId: string, content: string, header?: Record<string, unknown>): Promise<void> {
  const dir = sessionDir(taskId);
  await fs.mkdir(dir, { recursive: true });
  const h = header ?? {
    formatVersion: CURRENT_FORMAT_VERSION,
    taskId,
    createdAt: new Date().toISOString(),
    cwd: process.cwd(),
    logFile: "events.jsonl",
  };
  await fs.writeFile(path.join(dir, "header.json"), JSON.stringify(h, null, 2));
  await fs.writeFile(path.join(dir, "events.jsonl"), content);
}

test("append and read back", async () => {
  const taskId = uniqueTaskId("append");
  try {
    const el = new EventLog(taskId);
    await el.init(taskId, process.cwd());
    await el.append("test_event", { foo: "bar" });
    await el.append("another", 42);

    const events = await el.readLog();
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0]!.seq, 0);
    assert.strictEqual(events[0]!.type, "test_event");
    assert.deepStrictEqual(events[0]!.data, { foo: "bar" });
    assert.strictEqual(events[1]!.seq, 1);

    const standalone = await readLog(sessionDir(taskId));
    assert.strictEqual(standalone.length, 2);
  } finally {
    await cleanup(taskId);
  }
});

test("detects a seq gap", async () => {
  const taskId = uniqueTaskId("gap");
  try {
    await writeRawLog(taskId, eventsToFile([makeEvent(0), makeEvent(2)]));
    await assert.rejects(() => readLog(sessionDir(taskId)), ContiguityError);
  } finally {
    await cleanup(taskId);
  }
});

test("detects a duplicate seq", async () => {
  const taskId = uniqueTaskId("dup");
  try {
    await writeRawLog(taskId, eventsToFile([makeEvent(0), makeEvent(1), makeEvent(1)]));
    await assert.rejects(() => readLog(sessionDir(taskId)), ContiguityError);
  } finally {
    await cleanup(taskId);
  }
});

test("tolerates a torn final line on read", async () => {
  const taskId = uniqueTaskId("torn-read");
  try {
    const good = eventsToFile([makeEvent(0), makeEvent(1)]);
    await writeRawLog(taskId, good + '{"seq":2,"ts":1');
    const events = await readLog(sessionDir(taskId));
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1]!.seq, 1);
  } finally {
    await cleanup(taskId);
  }
});

test("repairs a torn final line when opened for write", async () => {
  const taskId = uniqueTaskId("torn-write");
  try {
    const good = eventsToFile([makeEvent(0), makeEvent(1)]);
    await writeRawLog(taskId, good + '{"seq":2,"ts":1');

    const el = new EventLog(taskId);
    await el.init(taskId, process.cwd());

    const raw = await fs.readFile(path.join(sessionDir(taskId), "events.jsonl"), "utf8");
    assert.strictEqual(raw, good);

    const events = await el.readLog();
    assert.strictEqual(events.length, 2);

    await el.append("after_repair", null);
    const after = await el.readLog();
    assert.strictEqual(after.length, 3);
    assert.strictEqual(after[2]!.seq, 2);
  } finally {
    await cleanup(taskId);
  }
});

test("compileMigrationChain rejects gaps, duplicates, and non-adjacent steps", () => {
  const ok: Migration = defineMigration({ from: 0, to: 1, migrateHeader: (h) => h, migrateEvent: (e) => e });
  assert.doesNotThrow(() => compileMigrationChain([ok]));
  assert.throws(() => compileMigrationChain([]), MigrationChainError);
  assert.throws(
    () =>
      compileMigrationChain([
        defineMigration({ from: 0, to: 1, migrateHeader: (h) => h, migrateEvent: (e) => e }),
        defineMigration({ from: 2, to: 3, migrateHeader: (h) => h, migrateEvent: (e) => e }),
      ]),
    MigrationChainError,
  );
  assert.throws(
    () =>
      compileMigrationChain([
        defineMigration({ from: 0, to: 1, migrateHeader: (h) => h, migrateEvent: (e) => e }),
        defineMigration({ from: 0, to: 1, migrateHeader: (h) => h, migrateEvent: (e) => e }),
      ]),
    MigrationChainError,
  );
  assert.throws(
    () => compileMigrationChain([defineMigration({ from: 0, to: 2, migrateHeader: (h) => h, migrateEvent: (e) => e })]),
    MigrationChainError,
  );
});

test("migrates an older format into a new generation file", async () => {
  const taskId = uniqueTaskId("migrate");
  try {
    const v0Events = [makeEvent(0, "a", { n: 1 }), makeEvent(1, "b", { n: 2 })];
    await writeRawLog(taskId, eventsToFile(v0Events), {
      formatVersion: 0,
      taskId,
      createdAt: new Date().toISOString(),
      cwd: process.cwd(),
      logFile: "events.jsonl",
    });

    const v0ToV1: Migration = defineMigration({
      from: 0,
      to: 1,
      migrateHeader: (h) => ({ ...h }),
      migrateEvent: (e) => ({ ...e, data: { ...(e.data as Record<string, unknown>), migrated: true } }),
    });

    const el = new EventLog(taskId);
    await el.init(taskId, process.cwd(), [v0ToV1]);

    const header = JSON.parse(await fs.readFile(path.join(sessionDir(taskId), "header.json"), "utf8")) as {
      formatVersion: number;
      logFile: string;
    };
    assert.strictEqual(header.formatVersion, 1);
    assert.strictEqual(header.logFile, "events.v1.jsonl");

    // Original generation is kept.
    const original = await fs.readFile(path.join(sessionDir(taskId), "events.jsonl"), "utf8");
    assert.strictEqual(original.split("\n").filter(Boolean).length, 2);

    const events = await el.readLog();
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(events[0]!.data, { n: 1, migrated: true });

    await el.append("c", null);
    const after = await el.readLog();
    assert.strictEqual(after.length, 3);
    assert.strictEqual(after[2]!.seq, 2);
  } finally {
    await cleanup(taskId);
  }
});

test("folds a projection over events", () => {
  const events = [makeEvent(0, "inc"), makeEvent(1, "inc"), makeEvent(2, "dec")];
  const count = foldProjections(events, {
    key: "count",
    init: () => 0,
    apply: (s, e) => s + (e.type === "inc" ? 1 : -1),
  });
  assert.strictEqual(count, 1);
});

test("projection cache is keyed by last seq and folds incrementally", () => {
  let applies = 0;
  const key = `cache-${process.pid}-${Date.now()}`;
  const projection = {
    key,
    init: () => 0,
    apply: (s: number, _e: LogEvent) => {
      applies += 1;
      return s + 1;
    },
  };
  registerProjection(projection);

  const first = getProjection(key, [makeEvent(0)]);
  assert.strictEqual(first, 1);
  assert.strictEqual(applies, 1);

  const same = getProjection(key, [makeEvent(0)]);
  assert.strictEqual(same, first);
  assert.strictEqual(applies, 1);

  const second = getProjection(key, [makeEvent(0), makeEvent(1)]);
  assert.strictEqual(second, 2);
  assert.strictEqual(applies, 2);
});

test("200 parallel appends keep contiguous seq", async () => {
  const taskId = uniqueTaskId("concurrent");
  try {
    const el = new EventLog(taskId);
    await el.init(taskId, process.cwd());
    await Promise.all(Array.from({ length: 200 }, (_, i) => el.append("e", i)));
    const events = await el.readLog();
    assert.strictEqual(events.length, 200);
    for (let i = 0; i < events.length; i++) {
      assert.strictEqual(events[i]!.seq, i);
      assert.deepStrictEqual(events[i]!.data, i);
    }
  } finally {
    await cleanup(taskId);
  }
});

test("flush fsyncs pending writes without throwing", async () => {
  const taskId = uniqueTaskId("flush");
  try {
    const el = new EventLog(taskId);
    await el.init(taskId, process.cwd());
    await el.append("a", 1);
    await el.append("b", 2);
    await el.flush();
    const events = await el.readLog();
    assert.strictEqual(events.length, 2);
  } finally {
    await cleanup(taskId);
  }
});
