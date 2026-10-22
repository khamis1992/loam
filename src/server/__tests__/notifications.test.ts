import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

interface NotificationLike {
  id: string;
  kind: Kind;
  title: string;
  body: string;
  taskId?: string;
  readAt?: string;
  createdAt: string;
}

interface NotificationsApi {
  createNotification: (input: { kind: Kind; title: string; body: string; taskId?: string; dedupe?: boolean }) => NotificationLike | undefined;
  notifyTaskStatus: (taskId: string, status: "done" | "error", extra?: { title?: string; error?: string }) => NotificationLike | undefined;
  notifyScheduleFailed: (scheduleId: string, prompt: string, error: string) => NotificationLike | undefined;
  notifyApprovalPending: (approval: { id: string; taskId: string; tool: string; summary: string }) => NotificationLike | undefined;
  listNotifications: (opts?: { unreadOnly?: boolean; limit?: number }) => NotificationLike[];
  unreadNotifications: () => number;
  markNotificationRead: (id: string) => NotificationLike | undefined;
  markAllNotificationsRead: () => number;
}

let tmpDir = "";
let closeDb: () => void;
let api: NotificationsApi;

type Kind = "task-done" | "task-failed" | "approval-pending" | "schedule-failed";

describe("notifications store", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-notifications-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    const mod = await import("../notifications.js");
    api = {
      createNotification: mod.createNotification,
      notifyTaskStatus: mod.notifyTaskStatus,
      notifyScheduleFailed: mod.notifyScheduleFailed,
      notifyApprovalPending: mod.notifyApprovalPending,
      listNotifications: mod.listNotifications,
      unreadNotifications: mod.unreadNotifications,
      markNotificationRead: mod.markNotificationRead,
      markAllNotificationsRead: mod.markAllNotificationsRead,
    };
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("records task completion and failure, deduping same-event emits", () => {
    const done = api.notifyTaskStatus("task_1", "done", { title: "Build website" });
    assert.ok(done);
    assert.equal(done!.kind, "task-done");
    assert.equal(done!.title, "Build website");
    assert.ok(!done!.readAt);

    // Duplicate emit for the same completion inside the window is suppressed.
    assert.equal(api.notifyTaskStatus("task_1", "done", { title: "Build website" }), undefined);
    assert.equal(api.listNotifications().filter((n) => n.taskId === "task_1").length, 1);

    const failed = api.notifyTaskStatus("task_2", "error", { title: "Import data", error: "boom" });
    assert.ok(failed);
    assert.equal(failed!.kind, "task-failed");
    assert.match(failed!.body, /boom/);
  });

  it("notifies schedule final failures", () => {
    const schedule = api.notifyScheduleFailed("sched_1", "daily digest", "runner crashed");
    assert.ok(schedule);
    assert.equal(schedule!.kind, "schedule-failed");
    assert.match(schedule!.title, /Routine/i);
    assert.match(schedule!.body, /daily digest/);
    assert.match(schedule!.body, /runner crashed/);
  });

  it("notifies pending approvals", () => {
    const approval = api.notifyApprovalPending({ id: "appr_1", taskId: "task_3", tool: "computer_click", summary: "click OK" });
    assert.ok(approval);
    assert.equal(approval!.kind, "approval-pending");
    assert.equal(approval!.taskId, "task_3");
    assert.match(approval!.title, /computer_click/);
  });

  it("lists newest first, supports unreadOnly and limit", () => {
    const all = api.listNotifications();
    assert.ok(all.length >= 4);
    assert.ok(all[0]!.createdAt >= all[all.length - 1]!.createdAt);

    const one = api.listNotifications({ limit: 1 });
    assert.equal(one.length, 1);

    const readTarget = all[all.length - 1]!;
    assert.ok(api.markNotificationRead(readTarget.id));
    const unread = api.listNotifications({ unreadOnly: true });
    assert.ok(unread.every((n) => !n.readAt));
    assert.ok(unread.length < all.length);
  });

  it("marks one read idempotently and all read at once", () => {
    const target = api.listNotifications().find((n) => !n.readAt)!;
    const first = api.markNotificationRead(target.id);
    assert.ok(first?.readAt);
    const readAt = first!.readAt;
    const again = api.markNotificationRead(target.id);
    assert.equal(again!.readAt, readAt); // readAt is not rewritten

    assert.ok(api.unreadNotifications() > 0);
    const affected = api.markAllNotificationsRead();
    assert.ok(affected > 0);
    assert.equal(api.unreadNotifications(), 0);
    assert.equal(api.markAllNotificationsRead(), 0);
  });

  it("rejects notifications without a title", () => {
    assert.equal(api.createNotification({ kind: "task-done", title: "   ", body: "x" }), undefined);
  });
});

