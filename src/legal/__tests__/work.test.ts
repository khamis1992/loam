import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { StaticKeyProvider } from "../crypto.js";
import { MattersStore } from "../mattersStore.js";

const input = { kind: "task" as const, title: "مراجعة المستندات", status: "pending" as const, dueAt: "2092-01-11", assignee: "المحامي المختبر", notes: "ملاحظة سرية" };

test("encrypted matter work items enforce ownership and produce an office report", () => {
  const store = new MattersStore(":memory:", new StaticKeyProvider(crypto.randomBytes(32)), () => new Date("2092-01-10T08:00:00Z"));
  try {
    const matter = store.createMatter({ title: "قضية إدارة العمل", kind: "defense_memo" }, "user");
    const other = store.createMatter({ title: "قضية أخرى", kind: "research" }, "user");
    const item = store.work.add(matter.id, input, "user");
    store.work.add(matter.id, { ...input, title: "موعد متأخر", dueAt: "2092-01-09" }, "user");
    const done = store.work.add(matter.id, { ...input, title: "مهمة منجزة", status: "done", dueAt: "2092-01-08" }, "user");

    assert.deepEqual(store.work.report(matter.id), { total: 3, pending: 2, inProgress: 0, done: 1, cancelled: 0, overdue: 1, nextDueAt: "2092-01-09" });
    assert.equal(done.completedAt, "2092-01-10T08:00:00.000Z");
    assert.throws(() => store.work.update(item.id, other.id, { status: "done" }, "user"), /not found/);
    assert.equal(store.work.delete(item.id, other.id, "user"), false);
    assert.throws(() => store.work.add(matter.id, { ...input, kind: "invalid" as typeof input.kind }, "user"), /invalid work item kind/);
    assert.throws(() => store.work.add(matter.id, { ...input, dueAt: "not-a-date" }, "user"), /invalid work item due date/);
    assert.throws(() => store.work.add(matter.id, { ...input, dueAt: "2092-02-31" }, "user"), /invalid work item due date/);

    const row = store.db.prepare("SELECT payload_enc FROM work_items WHERE id=?").get(item.id) as { payload_enc: string };
    assert.equal(row.payload_enc.includes("مراجعة المستندات"), false);
    assert.equal(row.payload_enc.includes("ملاحظة سرية"), false);
    const updated = store.work.update(item.id, matter.id, { status: "in_progress", notes: null }, "user");
    assert.equal(updated.status, "in_progress");
    assert.equal(updated.notes, null);
    assert.equal(updated.completedAt, null);
    assert.equal(store.audit.verifyChain(), null);
    assert.ok(store.audit.list({ matterId: matter.id }).some((event) => event.action === "work.update"));
    assert.equal(store.db.prepare("PRAGMA user_version").get()!.user_version, 5);
  } finally {
    store.close();
  }
});
