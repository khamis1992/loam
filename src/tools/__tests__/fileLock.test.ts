/**
 * Tests for the per-path async mutex (fileLock.ts) and its wiring into the
 * file-editing tools.
 *
 * Guarantees under test:
 *  - 50 concurrent read-modify-write edits to one file lose no updates
 *  - the same holds through the real file_edit tool (tools stay serialized)
 *  - 50 concurrent file_write appends to one file lose no updates
 *  - lockAll acquires paths in sorted order and cannot deadlock, even when the
 *    waiters arrive in the opposite order
 *  - lockAll returns one guard per path and holds them all at once
 *  - the FIFO chain keeps acquisition order and the map entry is pruned
 *  - lockKey normalizes spelling variants to one key (case-insensitive on Windows)
 *  - withLock/withLocks release in a finally even when the body throws
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { fileTools } from "../files.js";
import {
  isPathLocked,
  lock,
  lockAll,
  lockKey,
  lockMapSize,
  lockRefCount,
  withLock,
  withLocks,
} from "../fileLock.js";
import type { Tool, ToolContext } from "../registry.js";
import { ReadState } from "../readState.js";

const CONCURRENT = 50;
const SETTLE_TIMEOUT_MS = 5_000;

/** Resolve after `ms`, so two cycles provably overlap. */
function defer(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fail loudly instead of hanging if a lock ever deadlocks. */
async function settle<T>(p: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${SETTLE_TIMEOUT_MS}ms (deadlock?)`)), SETTLE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function findTool(name: string): Tool {
  const tool = fileTools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} is exported`);
  return tool;
}

function ctxFor(workspace: string): ToolContext {
  return { cfg: { policy: { allowOutsideWorkspaceRead: false } } as never, workspace, emit: () => {} };
}

describe("fileLock", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-filelock-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("serializes 50 concurrent read-modify-write cycles with no lost updates", async () => {
    const file = path.join(tmpDir, "f.txt");
    fs.writeFileSync(file, "", "utf8");

    // Each cycle reads, waits (so the cycles provably overlap), then appends.
    await settle(
      Promise.all(
        Array.from({ length: CONCURRENT }, (_, index) =>
          withLock(file, async () => {
            const content = fs.readFileSync(file, "utf8");
            await defer(1);
            fs.writeFileSync(file, `${content}${index}\n`, "utf8");
          }),
        ),
      ),
      "50 concurrent locked cycles",
    );

    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
    assert.equal(lines.length, CONCURRENT, "every concurrent edit must survive");
    assert.deepEqual(
      [...lines].sort((a, b) => Number(a) - Number(b)),
      Array.from({ length: CONCURRENT }, (_, i) => String(i)),
      "no index may be written twice or dropped",
    );
  });

  it("serializes 50 concurrent file_edit calls through the real tool", async () => {
    const file = path.join(tmpDir, "g.txt");
    // 50 unique, non-overlapping markers, one per edit. Each edit rewrites the
    // whole file, so a lost update would leave some marker unreplaced. The
    // markers must not be substrings of each other (m1 is a substring of m10),
    // or an edit would match several of them at once and be rejected as
    // ambiguous before it could race.
    const markers = Array.from({ length: CONCURRENT }, (_, i) => `M${String(i).padStart(3, "0")}`);
    fs.writeFileSync(file, markers.join("\n") + "\n", "utf8");

    const readState = new ReadState();
    readState.record(file);
    const ctx = { ...ctxFor(tmpDir), readState };
    const edit = findTool("file_edit");

    const results = await settle(
      Promise.all(
        Array.from({ length: CONCURRENT }, (_, index) =>
          edit.run({ path: "g.txt", old_string: markers[index]!, new_string: `X${String(index).padStart(3, "0")}` }, ctx),
        ),
      ),
      "50 concurrent file_edit calls",
    );

    for (const res of results) assert.equal(res.ok, true, res.content);
    const content = fs.readFileSync(file, "utf8");
    for (let i = 0; i < CONCURRENT; i++) {
      assert.match(content, new RegExp(`^X${String(i).padStart(3, "0")}$`, "m"), `edit ${i} must survive`);
      assert.doesNotMatch(content, new RegExp(`^${markers[i]}$`, "m"), `edit ${i} must not be left unreplaced`);
    }
  });

  it("serializes 50 concurrent file_write appends with no lost updates", async () => {
    const file = path.join(tmpDir, "w.txt");
    fs.writeFileSync(file, "", "utf8");
    const write = findTool("file_write");

    const results = await settle(
      Promise.all(
        Array.from({ length: CONCURRENT }, (_, index) =>
          write.run({ path: "w.txt", content: `${index}\n`, append: true }, ctxFor(tmpDir)),
        ),
      ),
      "50 concurrent file_write appends",
    );

    for (const res of results) assert.equal(res.ok, true, res.content);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
    assert.equal(lines.length, CONCURRENT, "every append must survive");
    assert.deepEqual(
      [...lines].sort((a, b) => Number(a) - Number(b)),
      Array.from({ length: CONCURRENT }, (_, i) => String(i)),
      "no append may be duplicated or dropped",
    );
  });

  it("acquires in FIFO order and drops the entry once released", async () => {
    const file = path.join(tmpDir, "h.txt");
    const order: number[] = [];
    const first = await lock(file);
    assert.equal(lockRefCount(file), 1);
    assert.ok(isPathLocked(file));

    const pending = [
      lock(file).then((unlock) => {
        order.push(1);
        unlock();
      }),
      lock(file).then((unlock) => {
        order.push(2);
        unlock();
      }),
    ];
    await defer(5);
    first();
    await Promise.all(pending);

    assert.deepEqual(order, [1, 2], "waiters must run in acquisition order");
    assert.equal(lockRefCount(file), 0);
    assert.equal(lockMapSize(), 0, "the map entry is pruned once nobody holds it");
    assert.equal(isPathLocked(file), false);
  });

  it("lockAll acquires in sorted order and never deadlocks with reversed waiters", async () => {
    const a = path.join(tmpDir, "a.txt");
    const b = path.join(tmpDir, "b.txt");
    fs.writeFileSync(a, "", "utf8");
    fs.writeFileSync(b, "", "utf8");

    // Hold both locks, then ask for them from two cycles in opposite orders.
    const outer = await lockAll([a, b]);
    assert.equal(outer.length, 2);
    const first = lockAll([a, b]).then((guards) => {
      guards.forEach((g) => g());
      return "ab";
    });
    const second = lockAll([b, a]).then((guards) => {
      guards.forEach((g) => g());
      return "ba";
    });

    // Sorted acquisition means both wait for `a` first, so neither can hold a
    // lock the other needs: releasing the outer set must let both proceed.
    await defer(10);
    outer.forEach((g) => g());
    assert.deepEqual(await settle(Promise.all([first, second]), "reversed lockAll waiters"), ["ab", "ba"]);
    assert.equal(lockMapSize(), 0);
  });

  it("lockAll returns one guard per path and holds them all at once", async () => {
    const a = path.join(tmpDir, "c.txt");
    const b = path.join(tmpDir, "d.txt");
    fs.writeFileSync(a, "", "utf8");
    fs.writeFileSync(b, "", "utf8");

    // Duplicated and unsorted input still yields exactly one guard per path,
    // in sorted key order, all held simultaneously.
    const guards = await lockAll([b, a, b]);
    assert.equal(guards.length, 2);
    assert.equal(lockRefCount(a), 1);
    assert.equal(lockRefCount(b), 1);

    // A third cycle must wait for both, proving both are genuinely held.
    let thirdRan = false;
    const third = lockAll([a, b]).then((g) => {
      thirdRan = true;
      g.forEach((release) => release());
    });
    await defer(5);
    assert.equal(thirdRan, false, "the third cycle must wait while both locks are held");

    guards.forEach((g) => g());
    await settle(third, "third lockAll cycle");
    assert.equal(thirdRan, true);
    assert.equal(lockMapSize(), 0);
  });

  it("lockKey normalizes spelling variants to one key", () => {
    const file = path.join(tmpDir, "e.txt");
    fs.writeFileSync(file, "x", "utf8");
    assert.equal(lockKey(file), lockKey(path.join(tmpDir, ".", "e.txt")));
    assert.equal(lockKey(file), lockKey(path.join(tmpDir, "sub", "..", "e.txt")));
    if (process.platform === "win32") {
      assert.equal(lockKey(file), lockKey(file.toUpperCase()));
    }
    // A missing file falls back to the resolved absolute path, never throwing.
    const missing = path.join(tmpDir, "missing.txt");
    assert.equal(lockKey(missing), lockKey(path.join(tmpDir, ".", "missing.txt")));
  });

  it("withLock and withLocks release in a finally when the body throws", async () => {
    const file = path.join(tmpDir, "i.txt");
    fs.writeFileSync(file, "", "utf8");

    await assert.rejects(
      withLock(file, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(lockRefCount(file), 0);
    assert.equal(lockMapSize(), 0);

    const other = path.join(tmpDir, "j.txt");
    await assert.rejects(
      withLocks([file, other], async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(lockRefCount(file), 0);
    assert.equal(lockRefCount(other), 0);
    assert.equal(lockMapSize(), 0);

    // A failed body must not wedge later cycles on the same path.
    assert.equal(await withLock(file, async () => "ok"), "ok");
  });

  it("withLocks serializes concurrent multi-file cycles", async () => {
    const a = path.join(tmpDir, "k.txt");
    const b = path.join(tmpDir, "l.txt");
    fs.writeFileSync(a, "a\n", "utf8");
    fs.writeFileSync(b, "b\n", "utf8");

    await settle(
      Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          withLocks([a, b], async () => {
            const first = fs.readFileSync(a, "utf8");
            const second = fs.readFileSync(b, "utf8");
            await defer(1);
            fs.writeFileSync(a, `${first}${index}\n`, "utf8");
            fs.writeFileSync(b, `${second}${index}\n`, "utf8");
          }),
        ),
      ),
      "20 concurrent two-file cycles",
    );

    assert.equal(fs.readFileSync(a, "utf8").split("\n").filter(Boolean).length, 21);
    assert.equal(fs.readFileSync(b, "utf8").split("\n").filter(Boolean).length, 21);
  });

  it("reports diagnostic state while a lock is held and queued", async () => {
    const file = path.join(tmpDir, "m.txt");
    const held = await lock(file);
    assert.equal(lockRefCount(file), 1);
    const queued = lock(file);
    assert.equal(lockRefCount(file), 2);
    assert.ok(isPathLocked(file));
    held();
    (await queued)();
    assert.equal(lockRefCount(file), 0);
  });
});

describe("file_move and file_delete locks", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-filelock-move-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("file_move acquires both paths without deadlocking against file_edit", async () => {
    const from = path.join(tmpDir, "from.txt");
    const to = path.join(tmpDir, "to.txt");
    fs.writeFileSync(from, "alpha\n", "utf8");

    const move = findTool("file_move");
    const edit = findTool("file_edit");
    const ctx = ctxFor(tmpDir);

    // A move and an edit racing on the same path must both settle: the move
    // holds both paths, so the edit either runs first (and is then moved) or
    // waits for the rename (and then fails as not-found). Neither may hang.
    const [moveRes, editRes] = await settle(
      Promise.all([
        move.run({ from: "from.txt", to: "to.txt" }, ctx),
        edit.run({ path: "from.txt", old_string: "alpha", new_string: "ALPHA" }, ctx),
      ]),
      "file_move vs file_edit",
    );

    assert.equal(moveRes.ok, true, moveRes.content);
    assert.ok(fs.existsSync(to), "the destination must exist after the move");
    // The edit either won the race (content moved with its change) or lost it
    // (the source was renamed away before it could run).
    if (editRes.ok) {
      assert.equal(fs.readFileSync(to, "utf8"), "ALPHA\n");
    } else {
      assert.match(editRes.content, /not found/i);
    }
    assert.equal(lockMapSize(), 0, "no lock leaks after the race");
  });
});
