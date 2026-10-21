import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { describe, it, after } from "node:test";
import { zipBuffer, zipDirectory, collectFiles } from "../zip.js";
import {
  deployBuild,
  createLocalDeployTarget,
  createVercelDeployTarget,
  createNetlifyDeployTarget,
  exportBuild,
  resolveBuildOutput,
  localDistDir,
} from "../deploy.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loam-deploy-"));
}

/** Independent minimal central-directory reader used to validate the writer. */
function readCentralEntries(zip: Buffer): Array<{ name: string; inflated: Buffer; crc: number }> {
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "zip starts with a local file header");
  // locate EOCD
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.subarray(i, i + 4).equals(eocdSig)) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, "EOCD present");
  const eocdOffset = eocd;
  const count = zip.readUInt16LE(eocdOffset + 10);
  const cdSize = zip.readUInt32LE(eocdOffset + 12);
  const cdOffset = zip.readUInt32LE(eocdOffset + 16);
  assert.equal(cdOffset + cdSize, eocdOffset, "central directory sits right before EOCD");

  const entries: Array<{ name: string; inflated: Buffer; crc: number }> = [];
  let cursor = cdOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50, "central header signature");
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const csize = zip.readUInt32LE(cursor + 20);
    const usize = zip.readUInt32LE(cursor + 24);
    const nameLen = zip.readUInt16LE(cursor + 28);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLen;
    const data = zip.subarray(dataStart, dataStart + csize);
    const inflated = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    assert.equal(inflated.length, usize, `inflated size for ${name}`);
    entries.push({ name, inflated, crc });
    cursor += 46 + nameLen;
  }
  return entries;
}

describe("preview zip writer", () => {
  after(() => {
    for (const dir of created) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
  const created: string[] = [];

  it("round-trips deflate entries through an independent reader", () => {
    const zip = zipBuffer([
      { name: "index.html", data: Buffer.from("<!doctype html><h1>مرحبا</h1>", "utf8") },
      { name: "assets/app.js", data: Buffer.from("console.log('hello'," + " world);".repeat(40)) },
      { name: "empty.txt", data: Buffer.alloc(0) },
    ]);
    const entries = readCentralEntries(zip);
    assert.deepEqual(entries.map((e) => e.name), ["index.html", "assets/app.js", "empty.txt"]);
    assert.match(entries[0]!.inflated.toString("utf8"), /مرحبا/);
    assert.equal(entries[2]!.inflated.length, 0);
  });

  it("collects directory files recursively and skips symlinks", () => {
    const root = tmpRoot();
    created.push(root);
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "a.txt"), "aaa");
    fs.writeFileSync(path.join(root, "sub", "b.txt"), "bbbb");
    const link = path.join(root, "link.txt");
    try { fs.symlinkSync("a.txt", link, "file"); } catch { /* unsupported FS */ }
    const entries = collectFiles(root);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("a.txt"));
    assert.ok(names.includes("sub/b.txt"));
    assert.ok(!names.includes("link.txt"), "symlinks excluded");
    const zip = zipDirectory(root);
    const read = readCentralEntries(zip);
    assert.deepEqual(read.map((e) => e.name), ["a.txt", "sub/b.txt"]);
    assert.equal(read[0]!.inflated.toString(), "aaa");
  });
});

describe("build discovery, export and local deploy", () => {
  const created: string[] = [];
  after(() => {
    for (const dir of created) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("finds dist/ first, then falls back to a root index.html", () => {
    const root = tmpRoot();
    created.push(root);
    assert.equal(resolveBuildOutput(root), null);
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>");
    let out = resolveBuildOutput(root);
    assert.equal(out?.relative, ".");
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist", "index.html"), "<html></html>");
    out = resolveBuildOutput(root);
    assert.equal(out?.relative, "dist");
  });

  it("exportBuild zips the build output and skips .loam staging", () => {
    const root = tmpRoot();
    created.push(root);
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist", "index.html"), "<p>طيب</p>");
    fs.writeFileSync(path.join(root, "dist", "app.js"), "// app");
    const info = exportBuild(root, "task_test1");
    assert.ok(fs.existsSync(info.zipPath));
    const head = fs.readFileSync(info.zipPath).subarray(0, 4);
    assert.equal(head.toString("latin1"), "PK\x03\x04");
    assert.ok(info.bytes > 0);
    assert.equal(info.fileCount, 2);
    // exports staging dir is not part of the zip when re-exported
    const entries = readCentralEntries(fs.readFileSync(info.zipPath));
    for (const e of entries) {
      assert.ok(!e.name.startsWith(".loam"), `no staging entries: ${e.name}`);
    }
  });

  it("local target writes dist files and returns URL without losing previous deploys", async () => {
    const root = tmpRoot();
    created.push(root);
    const distRoot = path.join(root, "dsite");
    const build = root;
    fs.mkdirSync(path.join(build, "dist"));
    fs.writeFileSync(path.join(build, "dist", "index.html"), "<html>one</html>");
    fs.writeFileSync(path.join(build, "dist", "style.css"), "body{color:#111}");

    const withoutServe = createLocalDeployTarget({ distRoot });
    const r1 = await withoutServe.deploy({ buildDir: path.join(build, "dist"), taskId: "task_s1" });
    assert.equal(r1.ok, true);
    assert.match(r1.url ?? "", /^file:\/\//);
    assert.ok(fs.existsSync(path.join(r1.distDir!, "index.html")));
    assert.ok(fs.existsSync(path.join(r1.distDir!, "style.css")));
    assert.ok(!fs.existsSync(`${r1.distDir}.deploying`), "staging dir renamed away");

    const withServe = createLocalDeployTarget({
      distRoot,
      serve: async (dir) => {
        assert.ok(fs.existsSync(path.join(dir, "index.html")));
        return "http://127.0.0.1:4321/";
      },
    });
    await withoutServe.deploy({ buildDir: path.join(build, "dist"), taskId: "task_s1" });
    const r2 = await withServe.deploy({ buildDir: path.join(build, "dist"), taskId: "task_s1" });
    assert.equal(r2.url, "http://127.0.0.1:4321/");
    // a fresh stamped dir per deploy: earlier copy still on disk
    assert.ok(r1.distDir !== r2.distDir);
    assert.ok(fs.existsSync(path.join(r2.distDir!, "index.html")));
    const zipBytes = fs.readFileSync(r2.zipPath!);
    assert.equal(zipBytes.toString("latin1", 0, 2), "PK");
  });

  it("localDistDir nests under a safe id segment", () => {
    const base = os.tmpdir();
    const safe = localDistDir(base, "task_ok");
    assert.equal(path.basename(path.dirname(safe)), "task_ok");
    const unsafe = localDistDir(base, "not/task*id");
    assert.equal(path.basename(path.dirname(unsafe)), "task");
  });

  it("cloud stubs report missing credentials and never deploy", async () => {
    const root = tmpRoot();
    created.push(root);
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist", "index.html"), "<html></html>");

    const saved = process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TOKEN;
    try {
      const vercel = deployBuild(root, "task_v", createVercelDeployTarget());
      const v = await vercel;
      assert.equal(v.result.ok, false);
      assert.deepEqual(v.result.missingEnv, ["VERCEL_TOKEN"]);
      assert.equal(v.result.url, null);

      const netlify = await deployBuild(root, "task_n", createNetlifyDeployTarget());
      assert.equal(netlify.result.ok, false);
      assert.deepEqual(netlify.result.missingEnv, ["NETLIFY_AUTH_TOKEN"]);
    } finally {
      if (saved !== undefined) process.env.VERCEL_TOKEN = saved;
    }
  });

  it("deployBuild without any build output throws an honest error", async () => {
    const root = tmpRoot();
    created.push(root);
    await assert.rejects(
      () => deployBuild(root, "task_x", createLocalDeployTarget({ distRoot: path.join(root, "out") })),
      /no build output found/,
    );
  });
});
