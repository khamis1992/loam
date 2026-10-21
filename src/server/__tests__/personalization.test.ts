import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

let tmpDir = "";
let closeDb: () => void;
let personalization: typeof import("../personalization.js");

describe("personalization", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-personalization-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    personalization = await import("../personalization.js");
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns empty defaults before anything is saved", () => {
    const p = personalization.getPersonalization();
    assert.equal(p.aboutMe, "");
    assert.equal(p.howToRespond, "");
    assert.equal(personalization.personalizationBlock(), "");
  });

  it("stores, trims and round-trips both fields", () => {
    const saved = personalization.savePersonalization({ aboutMe: "  I work in finance.  ", howToRespond: "Be concise." });
    assert.equal(saved.aboutMe, "I work in finance.");
    assert.equal(saved.howToRespond, "Be concise.");
    assert.equal(typeof saved.updatedAt, "string");

    const loaded = personalization.getPersonalization();
    assert.equal(loaded.aboutMe, "I work in finance.");
    assert.equal(loaded.howToRespond, "Be concise.");
    assert.equal(loaded.updatedAt, saved.updatedAt);
  });

  it("keeps the other field when only one is patched", () => {
    personalization.savePersonalization({ aboutMe: "second about" });
    const p = personalization.getPersonalization();
    assert.equal(p.aboutMe, "second about");
    assert.equal(p.howToRespond, "Be concise.");
  });

  it("ignores non-string patches and caps length", () => {
    personalization.savePersonalization({ aboutMe: 42, howToRespond: null });
    const before = personalization.getPersonalization();
    assert.equal(before.aboutMe, "second about");

    const long = "x".repeat(9000);
    personalization.savePersonalization({ howToRespond: long });
    const capped = personalization.getPersonalization();
    assert.equal(capped.howToRespond.length, 8000);
  });

  it("renders a prompt block covering both fields", () => {
    personalization.savePersonalization({ aboutMe: "I like tables.", howToRespond: "Always cite sources." });
    const block = personalization.personalizationBlock();
    assert.ok(block.startsWith("Custom instructions from the user"));
    assert.ok(block.includes("About the user: I like tables."));
    assert.ok(block.includes("How to respond: Always cite sources."));
  });

  it("renders no prompt block when the user cleared both fields", () => {
    personalization.savePersonalization({ aboutMe: "", howToRespond: "" });
    assert.equal(personalization.personalizationBlock(), "");
  });

  it("is injected into the built agent system prompt", async () => {
    personalization.savePersonalization({ aboutMe: "Prompt hook tester.", howToRespond: "" });
    const prompt = await import("../../agent/prompt.js");
    const cfg = { workspace: "/tmp/w", policy: { networkEnabled: false } } as unknown as import("../../config.js").Config;
    const text = prompt.buildSystemPrompt(cfg, [], ["file_read"], []);
    assert.ok(text.includes("About the user: Prompt hook tester."));
  });
});