/**
 * Neo N13: artifact packaging for a document/webpage node.
 *
 * A node's ZIP has to be a real archive that opens offline and lands in its own
 * folder, and it has to be *reproducible*: two captures of the same tree must be
 * byte-identical or a "download again" would silently differ from the first one.
 * These tests pin both properties, plus the path rules that keep a node from
 * packaging something outside its task workspace.
 *
 * Everything is filesystem-only: no network, no model calls.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { inflateRawSync } from "node:zlib";

import {
  buildArtifactZip,
  capturedFileEntries,
  entryPage,
  resolveArtifactDir,
  type ArtifactNode,
} from "../artifacts.js";

/** Minimal `unzip -l`: every local-file entry name, in archive order. */
function zipEntryNames(zip: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 4 <= zip.length) {
    // End of central directory record.
    if (zip.readUInt32LE(offset) === 0x06054b50) break;
    if (zip.readUInt32LE(offset) !== 0x04034b50) break;
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    // method 0 = stored, 8 = deflate. Only these two are ever emitted.
    const data = method === 0 ? raw : inflateRawSync(raw);
    // Round-trip through a Buffer so a text entry compares equal to its string.
    names.push(`${name}\u0000${Buffer.isBuffer(data) ? data.toString("utf8") : String(data)}`);
    offset = dataStart + compressedSize;
  }
  return names;
}

let root = "";

function node(overrides: Partial<ArtifactNode> = {}): ArtifactNode {
  return { id: "node_doc_1", type: "document", data: {}, ...overrides };
}

describe("node artifacts", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-node-artifacts-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    root = "";
  });

  function writeSite(): string {
    const dir = path.join(root, "site");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><h1>Hello</h1>", "utf8");
    fs.writeFileSync(path.join(dir, "styles.css"), "body { margin: 0 }", "utf8");
    fs.mkdirSync(path.join(dir, ".loam"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".loam", "staging.txt"), "must not ship", "utf8");
    return dir;
  }

  it("resolves the directory the node names, and its entry page", () => {
    const dir = writeSite();
    const artifact = resolveArtifactDir(node({ data: { path: "site/index.html" } }), root);
    assert.ok(artifact, "a node naming a file resolves to the file's directory");
    assert.equal(artifact.dir, dir);
    assert.equal(artifact.entry, "index.html", "index.html is the entry page");
    assert.equal(artifact.explicit, true, "the node named the directory itself");

    // A directory path resolves to the same place, so both payload shapes agree.
    const asDir = resolveArtifactDir(node({ data: { path: "site" } }), root);
    assert.equal(asDir?.dir, dir);
  });

  it("falls back to the workspace build output when the node names nothing", () => {
    const dir = writeSite();
    // The fallback only looks at a build output (`dist`/`build`/`out`/`www`) or a
    // root `index.html`, so `site/` is not a candidate by design.
    const artifact = resolveArtifactDir(node(), root);
    assert.equal(artifact, undefined, "a directory that is not a build output is not guessed at");

    const dist = path.join(root, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><h1>Built</h1>", "utf8");
    const built = resolveArtifactDir(node(), root);
    assert.ok(built, "a build output is found even without a payload path");
    assert.equal(built.dir, dist, "the workspace build output is used");
    assert.equal(built.explicit, false, "the fallback is marked as not explicit");
  });

  it("never resolves a path outside the task workspace", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "loam-node-outside-"));
    try {
      const escaped = resolveArtifactDir(node({ data: { path: path.join(outside, "site") } }), root);
      assert.equal(escaped, undefined, "an absolute path outside the workspace is refused");
      const traversal = resolveArtifactDir(node({ data: { path: `..${path.sep}${path.basename(outside)}${path.sep}site` } }), root);
      assert.equal(traversal, undefined, "a `..` traversal is refused");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("packages the site into one named folder and skips staging files", () => {
    const dir = writeSite();
    const zip = buildArtifactZip(dir, { prefix: "node-site" });
    const names = zipEntryNames(zip);
    const paths = names.map((entry) => entry.split("\u0000")[0]!);

    assert.ok(paths.includes("node-site/index.html"), "the page ships under the prefix");
    assert.ok(paths.includes("node-site/styles.css"), "the assets travel with the page");
    assert.ok(paths.every((entry) => entry.startsWith("node-site/")), "every entry is inside the folder");
    assert.ok(!paths.some((entry) => entry.includes(".loam")), "staging files never ship");
    // The page content round-trips, so the archive opens offline as the page.
    assert.equal(
      names.find((entry) => entry.startsWith("node-site/index.html"))?.split("\u0000")[1],
      "<!doctype html><h1>Hello</h1>",
    );
  });

  it("merges captured file versions in only where the directory has a gap", () => {
    const dir = writeSite();
    const extra = capturedFileEntries([{ title: "app.js", content: "console.log(1)" }, { title: "index.html", content: "overwritten" }]);
    const zip = buildArtifactZip(dir, { prefix: "node-site", extra });
    const names = zipEntryNames(zip);
    const paths = names.map((entry) => entry.split("\u0000")[0]!);

    assert.ok(paths.includes("node-site/app.js"), "a missing file is filled from the captured version");
    assert.ok(!paths.includes("node-site/index.html\noverwritten"), "no duplicate entry is created");
    const page = names.find((entry) => entry.startsWith("node-site/index.html"))?.split("\u0000")[1];
    assert.equal(page, "<!doctype html><h1>Hello</h1>", "the live file wins over the captured copy");
  });

  it("keeps two archives of the same tree byte-identical", () => {
    const dir = writeSite();
    const first = buildArtifactZip(dir, { prefix: "node-site" });
    const second = buildArtifactZip(dir, { prefix: "node-site" });
    assert.equal(first.equals(second), true, "a repeat download is the same archive");
  });

  it("gives captured files unique names when two share a basename", () => {
    const entries = capturedFileEntries([
      { title: "site/index.html", content: "one" },
      { title: "dist/index.html", content: "two" },
    ]);
    const names = entries.map((entry) => entry.name);
    assert.equal(new Set(names).size, 2, "both files survive under distinct names");
    assert.equal(entries[0]!.name, "index.html");
    assert.equal(entries[1]!.name, "2-index.html");
  });

  it("reports no entry page for a directory without HTML", () => {
    const dir = path.join(root, "assets");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "notes.txt"), "plain", "utf8");
    assert.equal(entryPage(dir), "", "no HTML file means no entry page");
  });
});
