import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { Config } from "../../config.js";
import type { AgentEvent, Emit } from "../../agent/events.js";
import type { ToolContext } from "../registry.js";
import { createArtifactTools, type ArtifactManifest } from "../artifactTools.js";

let workspace = "";
let outside = "";
const events: AgentEvent[] = [];

function ctx(ws: string): ToolContext {
  return { cfg: {} as Config, workspace: ws, emit: ((e: AgentEvent) => events.push(e)) as Emit };
}

function tool(): ReturnType<typeof createArtifactTools>[number] {
  return createArtifactTools().find((t) => t.name === "artifact_publish")!;
}

function manifest(): ArtifactManifest {
  return JSON.parse(fs.readFileSync(path.join(workspace, ".loam", "artifacts.json"), "utf8"));
}

function writeArtifact(name: string, contents: string): string {
  const rel = name;
  fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
  fs.writeFileSync(path.join(workspace, name), contents, "utf8");
  return rel;
}

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-artifact-publish-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "loam-artifact-outside-"));
});

after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("artifact_publish", () => {
  it("publishes a file, records the manifest and emits an event", async () => {
    const rel = writeArtifact("report.md", "# Quarterly report\n");
    events.length = 0;

    const res = await tool().run({ path: rel, kind: "report", title: "Quarterly report", description: "Q3 summary" }, ctx(workspace));

    assert.equal(res.ok, true);
    const parsed = JSON.parse(res.content);
    assert.equal(parsed.title, "Quarterly report");
    assert.equal(parsed.kind, "report");
    assert.equal(parsed.path, rel);
    assert.equal(parsed.mime, "text/markdown");
    assert.equal(parsed.size, Buffer.byteLength("# Quarterly report\n"));
    assert.match(parsed.sha256, /^[a-f0-9]{64}$/);

    const saved = manifest()[rel]!;
    assert.equal(saved.title, "Quarterly report");
    assert.equal(saved.description, "Q3 summary");
    assert.equal(saved.kind, "report");
    assert.equal(saved.sha256, parsed.sha256);
    assert.ok(saved.publishedAt);

    assert.equal(events.length, 1);
    const event = events[0] as Extract<AgentEvent, { type: "artifact_published" }>;
    assert.equal(event.type, "artifact_published");
    assert.equal(event.path, rel);
    assert.equal(event.kind, "report");
    assert.equal(event.title, "Quarterly report");
    assert.equal(event.sha256, parsed.sha256);
  });

  it("re-publishing the same path updates the existing entry", async () => {
    const rel = writeArtifact("deck.html", "<h1>Slides</h1>");
    await tool().run({ path: rel, kind: "deck", title: "First title" }, ctx(workspace));
    const first = manifest()[rel]!;

    await tool().run({ path: rel, kind: "page", title: "Updated title", description: "now a page" }, ctx(workspace));
    const second = manifest()[rel]!;

    assert.equal(Object.keys(manifest()).filter((k) => k === rel).length, 1);
    assert.notEqual(second.publishedAt, first.publishedAt);
    assert.equal(second.title, "Updated title");
    assert.equal(second.kind, "page");
    assert.equal(second.description, "now a page");
    assert.equal(second.sha256, first.sha256);
  });

  it("rejects a missing path", async () => {
    const res = await tool().run({ path: "nope.md", kind: "file", title: "Missing" }, ctx(workspace));
    assert.equal(res.ok, false);
    assert.match(res.content, /not found/);
  });

  it("rejects an empty or whitespace path", async () => {
    for (const p of ["", "   "]) {
      const res = await tool().run({ path: p, kind: "file", title: "Empty" }, ctx(workspace));
      assert.equal(res.ok, false);
      assert.match(res.content, /non-empty path/);
    }
  });

  it("rejects a directory", async () => {
    fs.mkdirSync(path.join(workspace, "folder"), { recursive: true });
    const res = await tool().run({ path: "folder", kind: "file", title: "Dir" }, ctx(workspace));
    assert.equal(res.ok, false);
    assert.match(res.content, /directory/);
  });

  it("rejects an empty file", async () => {
    writeArtifact("empty.txt", "");
    const res = await tool().run({ path: "empty.txt", kind: "file", title: "Empty file" }, ctx(workspace));
    assert.equal(res.ok, false);
    assert.match(res.content, /empty/);
  });

  it("rejects an invalid kind", async () => {
    const rel = writeArtifact("song.mp3", "audio");
    const res = await tool().run({ path: rel, kind: "podcast", title: "Song" }, ctx(workspace));
    assert.equal(res.ok, false);
    assert.match(res.content, /kind must be one of/);
  });

  it("rejects a path escaping the workspace", async () => {
    const rel = writeArtifact("secret.md", "top secret");
    await tool().run({ path: rel, kind: "file", title: "Secret" }, ctx(workspace));
    fs.writeFileSync(path.join(outside, "outside.md"), "outside");
    const escape = path.relative(workspace, path.join(outside, "outside.md"));

    const res = await tool().run({ path: escape, kind: "file", title: "Escape" }, ctx(workspace));
    assert.equal(res.ok, false);
    assert.match(res.content, /denied|outside workspace/);

    assert.equal(manifest()["../outside.md"], undefined);
    assert.ok(manifest()[rel], "the real artifact is still present");
  });
});
