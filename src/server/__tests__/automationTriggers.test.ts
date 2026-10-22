/**
 * D14 automation event triggers: HMAC-verified webhook + GitHub events.
 *
 * Exercises the pure trigger helpers and the POST /api/automations/trigger/:id
 * route with a mocked scheduled-run engine (no real agent, no network).
 */
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { Readable } from "node:stream";
import { describe, it, before, after } from "node:test";

let tmpDir = "";
let closeDb: () => void;
let db: typeof import("../db.js");
let triggers: typeof import("../webhookTriggers.js");

const SECRET = "whsec_test_secret";

interface Captured {
  status?: number;
  body?: any;
}

function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = {};
  const res = {
    writeHead(status: number) { captured.status = status; return res; },
    end(text?: unknown) { captured.body = text === undefined ? undefined : JSON.parse(String(text)); },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

async function callTrigger(id: string, raw: string | Buffer, headers: Record<string, string>): Promise<Captured> {
  const { handleAutomationsRoutes } = await import("../routes/automations.js");
  const req = Readable.from([Buffer.from(raw)]) as unknown as http.IncomingMessage;
  req.method = "POST";
  req.headers = headers;
  const { res, captured } = fakeRes();
  const handled = await handleAutomationsRoutes(req, res, `/api/automations/trigger/${encodeURIComponent(id)}`);
  assert.equal(handled, true, "trigger route must handle its path");
  return captured;
}

function hmac(body: string | Buffer, secret = SECRET): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

const started: Array<{ prompt: string; scheduleId: string }> = [];

describe("automation event triggers (D14)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-automations-triggers-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    db = await import("../db.js");
    triggers = await import("../webhookTriggers.js");
    (globalThis as { __loamScheduledRun?: unknown }).__loamScheduledRun = async (o: { prompt: string; scheduleId: string }) => {
      started.push({ prompt: o.prompt, scheduleId: o.scheduleId });
      return `task_${started.length}`;
    };
  });

  after(() => {
    delete (globalThis as { __loamScheduledRun?: unknown }).__loamScheduledRun;
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("verifies HMAC signatures and rejects a bad or missing signature", () => {
    const body = JSON.stringify({ hello: "world" });
    const good = triggers.parseSignatureHeader(hmac(body))!;
    const bad = triggers.parseSignatureHeader(hmac(body, "other"))!;
    assert.equal(triggers.verifyHmacSignature(body, good, SECRET), true, "good signature verifies");
    assert.equal(triggers.verifyHmacSignature(body, bad, SECRET), false, "wrong secret rejected");
    assert.equal(triggers.verifyHmacSignature(body, undefined, SECRET), false, "missing signature rejected");
    assert.equal(triggers.verifyHmacSignature(body, good, undefined), false, "missing secret rejected");
    assert.equal(triggers.parseSignatureHeader(`sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`), hmac(body).slice("sha256=".length));
  });

  it("webhook: bad signature rejected, good signature starts a session with the payload prompt", async () => {
    const s = db.addSchedule("fallback prompt", 3600, undefined, undefined, undefined, undefined, true, { trigger: "webhook", webhookSecret: SECRET });
    const body = JSON.stringify({ prompt: "deploy finished", extra: 1 });

    const bad = await callTrigger(s.id, body, { "x-loam-signature": hmac(body, "nope") });
    assert.equal(bad.status, 401, "bad signature must be rejected");

    const good = await callTrigger(s.id, body, { "x-loam-signature": hmac(body) });
    assert.equal(good.status, 202, "good signature starts the session");
    assert.equal(good.body.started, true);
    assert.equal(started.at(-1)?.prompt, "deploy finished", "webhook payload prompt wins");
    assert.equal(started.at(-1)?.scheduleId, s.id);
  });

  it("webhook: an empty body falls back to the stored prompt", async () => {
    const s = db.addSchedule("nightly digest", 3600, undefined, undefined, undefined, undefined, true, { trigger: "webhook", webhookSecret: SECRET });
    const cap = await callTrigger(s.id, "", { "x-loam-signature": hmac("") });
    assert.equal(cap.status, 202);
    assert.equal(started.at(-1)?.prompt, "nightly digest");
  });

  it("github: PR-comment payload maps to the session prompt", async () => {
    const s = db.addSchedule("review PR", 3600, undefined, undefined, undefined, undefined, true, { trigger: "github", webhookSecret: SECRET, githubEvents: ["issue_comment.created"] });
    const payload = {
      action: "created",
      repository: { full_name: "acme/api" },
      issue: { number: 42, title: "Add retry", pull_request: { url: "https://api.github.com/repos/acme/api/pulls/42" } },
      comment: { body: "Please fix the flaky test." },
    };
    const body = JSON.stringify(payload);
    const cap = await callTrigger(s.id, body, { "x-github-event": "issue_comment", "x-hub-signature-256": hmac(body) });
    assert.equal(cap.status, 202, "subscribed PR comment fires");
    const prompt = started.at(-1)?.prompt ?? "";
    assert.match(prompt, /\[GitHub\] New comment on PR #42 in acme\/api: Add retry/);
    assert.match(prompt, /Please fix the flaky test\./);
  });

  it("github: issue opened/labeled payloads map to prompts", () => {
    const opened = triggers.githubPayloadToPrompt("issues.opened", {
      repository: { full_name: "acme/api" },
      issue: { number: 7, title: "Bug", body: "It broke" },
    }, "fallback");
    assert.match(opened!, /New issue #7 in acme\/api: Bug/);
    assert.match(opened!, /It broke/);

    const labeled = triggers.githubPayloadToPrompt("issues.labeled", {
      repository: { full_name: "acme/api" },
      issue: { number: 8, title: "Feature" },
      label: { name: "triage" },
    }, "fallback");
    assert.match(labeled!, /Issue #8 in acme\/api labeled "triage": Feature/);
  });

  it("github: unsubscribed events are ignored and plain-issue comments do not map", async () => {
    const s = db.addSchedule("issues only", 3600, undefined, undefined, undefined, undefined, true, { trigger: "github", webhookSecret: SECRET, githubEvents: ["issues.opened"] });
    const body = JSON.stringify({ action: "created", repository: { full_name: "acme/api" }, issue: { number: 1, title: "x", pull_request: {} }, comment: { body: "hi" } });
    const ignored = await callTrigger(s.id, body, { "x-github-event": "issue_comment", "x-hub-signature-256": hmac(body) });
    assert.equal(ignored.status, 202);
    assert.equal(ignored.body.ignored, true);
    assert.equal(started.length >= 1, true);

    const plainIssue = triggers.githubPayloadToPrompt("issue_comment.created", { issue: { number: 1, title: "x" }, comment: { body: "hi" } }, "fallback");
    assert.equal(plainIssue, undefined, "comments on plain issues are not triggers");
  });

  it("a cron automation cannot be fired through the trigger route", async () => {
    const s = db.addSchedule("cron job", 3600, undefined, undefined, "cron");
    const cap = await callTrigger(s.id, "{}", { "x-loam-signature": hmac("{}") });
    assert.equal(cap.status, 400);
  });

  it("webhook secrets are never returned by the list projection", () => {
    const s = db.addSchedule("secret", 3600, undefined, undefined, undefined, undefined, true, { trigger: "webhook", webhookSecret: SECRET });
    const projected = db.publicSchedule(s);
    assert.ok(!("webhookSecret" in projected), "webhookSecret must be stripped");
    assert.equal(projected.trigger, "webhook");
  });
});
