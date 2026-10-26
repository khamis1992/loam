import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FieldCipher, StaticKeyProvider } from "../crypto.js";
import { clearLegalProtection, configureLegalProtection, markLegalSession } from "../security/protection.js";
import { assertLegalPromptAllowed } from "../runConfig.js";

test("legal tasks, runs, inputs and event log never persist client text in clear", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-transcript-"));
  process.env.MANUS_LOCAL_DATA_DIR = dir;
  const cipher = new FieldCipher(new StaticKeyProvider(crypto.randomBytes(32)));
  configureLegalProtection({ seal: (value, aad) => ({ marker: "loam-legal-sealed/v1", aad, ciphertext: cipher.sealJson(value, aad) }), open: (value) => {
    const sealed = value as { aad: string; ciphertext: string };
    return cipher.openJson(sealed.ciphertext, sealed.aad);
  } });
  try {
    const db = await import("../../server/db.js");
    const { database } = await import("../../server/sqliteStore.js");
    const task = db.createTask("", "Legal matter");
    db.setTaskMode(task.id, "legal");
    markLegalSession(task.id);
    db.appendMessage(task.id, "user", "شركة الاختبار تطالب بمبلغ 999111");
    db.appendStep(task.id, { at: new Date().toISOString(), type: "tool_result", data: { text: "واقعة سرية 12345" } });
    db.saveRun(task.id, {
      prompt: "حلل قضية شركة الاختبار", effectivePrompt: "حلل قضية شركة الاختبار", history: [{ role: "user", content: "سر المحادثة" }],
      workspace: dir, mode: "legal", orchestrated: false, started: true,
    });
    const inputs = await import("../../server/inputQueue.js");
    inputs.enqueue({ id: "input-secret", sessionId: task.id, text: "نص المدخل السري", delivery: "queued" });
    const admitted = inputs.admitPending(task.id);
    assert.equal(admitted[0]?.text, "نص المدخل السري");
    const raw = JSON.stringify([
      database().prepare("SELECT payload FROM entities WHERE kind IN ('tasks','runs','inputs')").all(),
      database().prepare("SELECT payload FROM session_events").all(),
    ]);
    for (const secret of ["شركة الاختبار", "999111", "واقعة سرية", "سر المحادثة", "نص المدخل السري"]) assert.ok(!raw.includes(secret), secret);
    assert.equal(db.getTask(task.id)?.messages[0]?.content.includes("شركة الاختبار"), true);
    assert.equal(db.getSavedRun(task.id)?.history[0]?.content, "سر المحادثة");
    const { after } = await import("../../protocol/eventLog.js");
    assert.equal((after(task.id)[0]?.payload as { text?: string } | undefined)?.text, "نص المدخل السري");
    db.closeDb();
  } finally {
    clearLegalProtection();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cloud_redacted refuses a prompt containing registered identities", () => {
  const matter = { parties: [{ role: "client" as const, name: "شركة الاختبار", identifiers: ["28463400123"] }] };
  assert.throws(() => assertLegalPromptAllowed("وشركة الاختبار توضح", matter, { redact: true }), /prompt contains/);
  assert.throws(() => assertLegalPromptAllowed("الهوية 28463400123", matter, { redact: true }), /prompt contains/);
  assert.doesNotThrow(() => assertLegalPromptAllowed("حلل البنود العامة", matter, { redact: true }));
  assert.doesNotThrow(() => assertLegalPromptAllowed("وشركة الاختبار توضح", matter, { redact: false }));
});
