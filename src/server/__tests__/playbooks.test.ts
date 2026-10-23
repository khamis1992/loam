/**
 * Playbooks (D9) — store, version history, macro expansion and the HTTP surface.
 *
 * Covers the acceptance criteria:
 *   - CRUD + version history (content edit appends an immutable version; a
 *     rename/re-macro does not)
 *   - `!macro` expansion in a chat prompt (attached blocks, unknown macros left
 *     in place, dedupe, case-insensitivity)
 *   - the /api/playbooks routes (list/create/read/edit/delete/versions/restore)
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { Readable } from "node:stream";
import { describe, it, before, after } from "node:test";

let tmpDir = "";
let closeDb: () => void;
let pb: typeof import("../playbooks.js");

const SECTIONS = {
  overview: "Ship a release safely.",
  procedure: "1. Run tests\n2. Tag the commit",
  specifications: "Use npm run build:server",
  advice: "Never tag before the build passes.",
  forbiddenActions: "Do not push directly to main.",
  neededFromUser: "The version number.",
};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-playbooks-"));
  process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  const sqlite = await import("../sqliteStore.js");
  closeDb = sqlite.closeDb;
  pb = await import("../playbooks.js");
});

after(() => {
  closeDb();
  delete process.env.MANUS_LOCAL_DATA_DIR;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("playbook store: CRUD + version history", () => {
  it("creates a playbook at version 1 and reads it back by id and macro", () => {
    const created = pb.createPlaybook({ name: "Release checklist", macro: "release", ...SECTIONS });
    assert.match(created.id, /^pb_/);
    assert.equal(created.macro, "release");
    assert.equal(created.currentVersion, 1);
    assert.equal(created.overview, SECTIONS.overview);

    assert.equal(pb.getPlaybook(created.id)?.name, "Release checklist");
    // The leading `!` is optional and the lookup is case-insensitive.
    assert.equal(pb.getPlaybookByMacro("release")?.id, created.id);
    assert.equal(pb.getPlaybookByMacro("!RELEASE")?.id, created.id);
    assert.equal(pb.listPlaybooks().length, 1);
    assert.deepEqual(pb.listVersions(created.id).map((v) => v.version), [1]);
  });

  it("normalizes and validates macros", () => {
    assert.equal(pb.normalizeMacro("!My_Macro"), "my_macro");
    assert.equal(pb.normalizeMacro("  !!Release  "), "release");
    assert.ok(pb.isValidMacro("release_2"));
    assert.ok(!pb.isValidMacro("2release"));
    assert.ok(!pb.isValidMacro(""));
    assert.throws(() => pb.assertValidMacro(""), /macro is required/);
    assert.throws(() => pb.assertValidMacro("Bad-Macro"), /lowercase letters/);
  });

  it("rejects a duplicate macro and an over-long name", () => {
    pb.createPlaybook({ name: "One", macro: "dup" });
    assert.throws(() => pb.createPlaybook({ name: "Two", macro: "dup" }), /already exists/);
    assert.throws(() => pb.createPlaybook({ name: "", macro: "blank" }), /name is required/);
    assert.throws(() => pb.createPlaybook({ name: "x".repeat(pb.NAME_MAX + 1), macro: "toolong" }), /at most/);
  });

  it("appends an immutable version on a content edit and keeps history", () => {
    const created = pb.createPlaybook({ name: "Release checklist", macro: "hist", ...SECTIONS });
    const v1 = pb.getVersion(created.id, 1)!;
    assert.equal(v1.procedure, SECTIONS.procedure);

    const updated = pb.updatePlaybook(created.id, { procedure: "1. Run tests\n2. Build\n3. Tag" })!;
    assert.equal(updated.currentVersion, 2);
    assert.equal(updated.procedure, "1. Run tests\n2. Build\n3. Tag");

    const versions = pb.listVersions(created.id);
    assert.deepEqual(versions.map((v) => v.version), [2, 1], "newest first");
    // The historical version is untouched.
    assert.equal(pb.getVersion(created.id, 1)!.procedure, SECTIONS.procedure);
    assert.equal(pb.getVersion(created.id, 2)!.procedure, "1. Run tests\n2. Build\n3. Tag");
    // The live playbook points at version 2.
    assert.equal(pb.getCurrentVersionContent(created.id)?.procedure, "1. Run tests\n2. Build\n3. Tag");
    // v1 row identity is preserved (immutable history, not rewritten).
    assert.equal(pb.getVersion(created.id, 1)!.id, v1.id);
  });

  it("does not create a version when only the name or macro changes", () => {
    const created = pb.createPlaybook({ name: "Original", macro: "meta", ...SECTIONS });
    const renamed = pb.updatePlaybook(created.id, { name: "Renamed" })!;
    assert.equal(renamed.name, "Renamed");
    assert.equal(renamed.currentVersion, 1, "a rename is not a content change");
    assert.deepEqual(pb.listVersions(created.id).map((v) => v.version), [1]);

    const reMacro = pb.updatePlaybook(created.id, { macro: "meta2" })!;
    assert.equal(reMacro.macro, "meta2");
    assert.equal(reMacro.currentVersion, 1);
    assert.deepEqual(pb.listVersions(created.id).map((v) => v.version), [1]);
  });

  it("returns the unchanged playbook for a no-op update", () => {
    const created = pb.createPlaybook({ name: "Noop", macro: "noop", ...SECTIONS });
    const same = pb.updatePlaybook(created.id, { overview: SECTIONS.overview });
    assert.equal(same?.id, created.id);
    assert.equal(same?.currentVersion, 1);
    assert.deepEqual(pb.listVersions(created.id).map((v) => v.version), [1]);
  });

  it("rejects re-macroing onto an existing macro", () => {
    pb.createPlaybook({ name: "A", macro: "alpha" });
    const b = pb.createPlaybook({ name: "B", macro: "beta" });
    assert.throws(() => pb.updatePlaybook(b.id, { macro: "alpha" }), /already exists/);
  });

  it("deletes a playbook and its versions", () => {
    const created = pb.createPlaybook({ name: "Temp", macro: "temp", ...SECTIONS });
    pb.updatePlaybook(created.id, { advice: "changed" });
    assert.equal(pb.listVersions(created.id).length, 2);
    assert.equal(pb.deletePlaybook(created.id), true);
    assert.equal(pb.getPlaybook(created.id), undefined);
    assert.deepEqual(pb.listVersions(created.id), []);
    assert.equal(pb.deletePlaybook(created.id), false);
  });

  it("derives a valid, still-unused macro from a free-form name", () => {
    assert.equal(pb.deriveMacro("Release Checklist"), "release_checklist");
    assert.equal(pb.deriveMacro("Release Checklist", (m) => m === "release_checklist"), "release_checklist_2");
    assert.equal(pb.deriveMacro("!!!", () => false), "playbook");
  });
});

describe("playbook macro expansion", () => {
  it("appends the rendered block for a known macro and leaves the prompt intact", () => {
    pb.createPlaybook({ name: "Release checklist", macro: "expand_release", ...SECTIONS });
    const expansion = pb.expandPlaybookMacros("Ship it !expand_release please");
    assert.equal(expansion.attached.length, 1);
    assert.equal(expansion.attached[0]!.macro, "expand_release");
    assert.deepEqual(expansion.unknown, []);
    assert.ok(expansion.text.startsWith("Ship it !expand_release please"));
    assert.ok(expansion.text.includes("[Playbook: Release checklist (!expand_release) v1]"));
    assert.ok(expansion.text.includes("## Procedure"));
    assert.ok(expansion.text.includes("1. Run tests"));
  });

  it("reports unknown macros and leaves their tokens untouched", () => {
    pb.createPlaybook({ name: "Known", macro: "expand_known", ...SECTIONS });
    const expansion = pb.expandPlaybookMacros("!expand_known and !missing");
    assert.deepEqual(expansion.attached.map((p) => p.macro), ["expand_known"]);
    assert.deepEqual(expansion.unknown, ["missing"]);
    assert.ok(expansion.text.includes("!missing"), "an unknown macro must stay visible in the prompt");
  });

  it("deduplicates repeated macros and expands several in first-seen order", () => {
    pb.createPlaybook({ name: "Alpha", macro: "expand_alpha", overview: "A" });
    pb.createPlaybook({ name: "Beta", macro: "expand_beta", overview: "B" });
    const expansion = pb.expandPlaybookMacros("!expand_alpha then !expand_beta then !expand_alpha again");
    assert.deepEqual(expansion.attached.map((p) => p.macro), ["expand_alpha", "expand_beta"]);
    const first = expansion.text.indexOf("[Playbook: Alpha");
    const second = expansion.text.indexOf("[Playbook: Beta");
    assert.ok(first !== -1 && second !== -1 && first < second, "first-seen order");
  });

  it("returns the text unchanged when nothing matches", () => {
    const expansion = pb.expandPlaybookMacros("no macros here");
    assert.equal(expansion.text, "no macros here");
    assert.deepEqual(expansion.attached, []);
    assert.deepEqual(expansion.unknown, []);
  });

  it("does not treat a macro-looking token inside a word as a macro", () => {
    pb.createPlaybook({ name: "Email", macro: "email", overview: "E" });
    const expansion = pb.expandPlaybookMacros("write me an email_thing");
    assert.deepEqual(expansion.attached, [], "a token glued to word characters is not a macro");
    assert.deepEqual(expansion.unknown, []);
  });

  it("renders an empty section-less playbook as just its header", () => {
    pb.createPlaybook({ name: "Empty", macro: "empty" });
    const rendered = pb.renderPlaybookPrompt(pb.getPlaybookByMacro("empty")!);
    assert.equal(rendered, "[Playbook: Empty (!empty) v1]");
  });
});

interface Captured {
  status?: number;
  body?: unknown;
}

function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = {};
  const res = {
    writeHead(status: number) { captured.status = status; return res; },
    end(text?: unknown) { captured.body = text === undefined ? undefined : JSON.parse(String(text)); },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

async function call(method: string, p: string, body?: unknown): Promise<Captured> {
  const { handlePlaybookRoutes } = await import("../routes/playbooks.js");
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
  req.method = method;
  const { res, captured } = fakeRes();
  const handled = await handlePlaybookRoutes(req, res, p);
  assert.equal(handled, true, `${method} ${p} must be handled by the module`);
  return captured;
}

/** Send a raw (non-JSON) body so the route's parser is exercised directly. */
async function callRaw(method: string, p: string, raw: string): Promise<Captured> {
  const { handlePlaybookRoutes } = await import("../routes/playbooks.js");
  const req = Readable.from([Buffer.from(raw)]) as unknown as http.IncomingMessage;
  req.method = method;
  const { res, captured } = fakeRes();
  const handled = await handlePlaybookRoutes(req, res, p);
  assert.equal(handled, true, `${method} ${p} must be handled by the module`);
  return captured;
}

describe("playbook routes", () => {
  it("creates, reads, edits and deletes a playbook over HTTP", async () => {
    const created = await call("POST", "/api/playbooks", { name: "HTTP one", macro: "http_one", overview: "o" });
    assert.equal(created.status, 201);
    const playbook = (created.body as { playbook: { id: string; macro: string; currentVersion: number } }).playbook;
    assert.equal(playbook.macro, "http_one");
    assert.equal(playbook.currentVersion, 1);

    const listed = await call("GET", "/api/playbooks");
    assert.equal(listed.status, 200);
    assert.ok((listed.body as { playbooks: Array<{ id: string }> }).playbooks.some((p) => p.id === playbook.id));

    const read = await call("GET", `/api/playbooks/${playbook.id}`);
    assert.equal(read.status, 200);
    assert.equal((read.body as { playbook: { id: string } }).playbook.id, playbook.id);

    // Read by macro too (with the leading `!`).
    const byMacro = await call("GET", "/api/playbooks/!http_one");
    assert.equal(byMacro.status, 200);

    const patched = await call("PATCH", `/api/playbooks/${playbook.id}`, { procedure: "new steps" });
    assert.equal(patched.status, 200);
    const patchedPb = (patched.body as { playbook: { currentVersion: number; procedure: string } }).playbook;
    assert.equal(patchedPb.currentVersion, 2);
    assert.equal(patchedPb.procedure, "new steps");

    const deleted = await call("DELETE", `/api/playbooks/${playbook.id}`);
    assert.equal(deleted.status, 200);
    assert.equal((deleted.body as { deleted: boolean }).deleted, true);
    const gone = await call("GET", `/api/playbooks/${playbook.id}`);
    assert.equal(gone.status, 404);
  });

  it("validates the create body", async () => {
    assert.equal((await call("POST", "/api/playbooks", { macro: "x" })).status, 400, "name required");
    assert.equal((await call("POST", "/api/playbooks", { name: "X" })).status, 400, "macro required");
    assert.equal((await call("POST", "/api/playbooks", { name: "X", macro: "Bad-Macro" })).status, 400, "macro shape");
    await call("POST", "/api/playbooks", { name: "Dup", macro: "route_dup" });
    assert.equal((await call("POST", "/api/playbooks", { name: "Dup 2", macro: "route_dup" })).status, 409);
    assert.equal((await callRaw("POST", "/api/playbooks", "not json")).status, 400);
  });

  it("lists version history and restores a historical version", async () => {
    const created = await call("POST", "/api/playbooks", { name: "History", macro: "route_hist", overview: "v1 body" });
    const id = (created.body as { playbook: { id: string } }).playbook.id;
    await call("PATCH", `/api/playbooks/${id}`, { overview: "v2 body" });
    await call("PATCH", `/api/playbooks/${id}`, { overview: "v3 body" });

    const history = await call("GET", `/api/playbooks/${id}/versions`);
    assert.equal(history.status, 200);
    const versions = (history.body as { versions: Array<{ version: number; overview: string }> }).versions;
    assert.deepEqual(versions.map((v) => v.version), [3, 2, 1]);
    assert.equal(versions[2]!.overview, "v1 body");

    const one = await call("GET", `/api/playbooks/${id}/versions/1`);
    assert.equal(one.status, 200);
    assert.equal((one.body as { version: { overview: string } }).version.overview, "v1 body");
    assert.equal((await call("GET", `/api/playbooks/${id}/versions/99`)).status, 404);

    const restored = await call("POST", `/api/playbooks/${id}/versions/1/restore`);
    assert.equal(restored.status, 200);
    const restoredPb = (restored.body as { playbook: { currentVersion: number; overview: string } }).playbook;
    assert.equal(restoredPb.currentVersion, 4, "a restore appends a new version");
    assert.equal(restoredPb.overview, "v1 body");
    // The restored content is now version 4 and the older rows are intact.
    const after = await call("GET", `/api/playbooks/${id}/versions`);
    assert.deepEqual((after.body as { versions: Array<{ version: number }> }).versions.map((v) => v.version), [4, 3, 2, 1]);
  });

  it("returns 404 for an unknown playbook and 405 for a bad method", async () => {
    assert.equal((await call("GET", "/api/playbooks/pb_missing")).status, 404);
    assert.equal((await call("GET", "/api/playbooks/!nope")).status, 404);
    assert.equal((await call("PUT", "/api/playbooks")).status, 405);
  });

  it("leaves unrelated paths unhandled", async () => {
    const { handlePlaybookRoutes } = await import("../routes/playbooks.js");
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.method = "GET";
    const { res } = fakeRes();
    assert.equal(await handlePlaybookRoutes(req, res, "/api/agents"), false);
    assert.equal(await handlePlaybookRoutes(req, res, "/api/playbooksx"), false);
  });
});
