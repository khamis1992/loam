/**
 * Frontier-quality hardening tests for preview/deploy.ts.
 *
 * Covers the production invariants the original suite did not:
 *  - a failed deploy never destroys the previously deployed copy
 *  - same-millisecond deploys/exports never collide or overwrite history
 *  - the root-index.html fallback excludes `.loam` staging from its count
 *  - the local URL falls back to the dist dir when index.html is absent
 *  - credential/catalog/segment helpers behave deterministically
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  createLocalDeployTarget,
  createVercelDeployTarget,
  deployBuild,
  directDistWriter,
  exportBuild,
  findTarget,
  missingCredentials,
  resolveBuildOutput,
  safeSegment,
  targetCatalog,
  timestampSegment,
  uniqueLocalDistDir,
  withCollisionSuffix,
} from "../deploy.js";

const created: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-deploy-harden-"));
  created.push(dir);
  return dir;
}

function makeBuild(root: string, files: Record<string, string> = { "index.html": "<html></html>" }): string {
  const dir = path.join(root, "dist");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

after(() => {
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("deploy hardening", () => {
  it("a failed deploy preserves the previous deployed copy", async () => {
    const root = tmpRoot();
    const distRoot = path.join(root, "dsite");
    const buildDir = makeBuild(root);

    const good = createLocalDeployTarget({ distRoot });
    const first = await good.deploy({ buildDir, taskId: "task_keep" });
    assert.equal(first.ok, true);
    assert.ok(fs.existsSync(path.join(first.distDir!, "index.html")));

    const bad = createLocalDeployTarget({
      distRoot,
      writer: {
        write() {
          throw new Error("simulated write failure");
        },
      },
    });
    await assert.rejects(() => bad.deploy({ buildDir, taskId: "task_keep" }), /simulated write failure/);

    assert.ok(
      fs.existsSync(path.join(first.distDir!, "index.html")),
      "previous deploy must survive a failed redeploy",
    );
  });

  it("same-millisecond exports never collide", () => {
    const root = tmpRoot();
    makeBuild(root);
    const a = exportBuild(root, "task_collide");
    const b = exportBuild(root, "task_collide");
    assert.notEqual(a.zipPath, b.zipPath, "export paths must be unique");
    assert.ok(fs.existsSync(a.zipPath));
    assert.ok(fs.existsSync(b.zipPath));
  });

  it("same-millisecond local deploys keep both copies", async () => {
    const root = tmpRoot();
    const distRoot = path.join(root, "dsite");
    const buildDir = makeBuild(root);
    const target = createLocalDeployTarget({ distRoot });
    const a = await target.deploy({ buildDir, taskId: "task_collide" });
    const b = await target.deploy({ buildDir, taskId: "task_collide" });
    assert.notEqual(a.distDir, b.distDir, "dist dirs must be unique");
    assert.ok(fs.existsSync(path.join(a.distDir!, "index.html")));
    assert.ok(fs.existsSync(path.join(b.distDir!, "index.html")));
  });

  it("withCollisionSuffix appends the first free -N suffix", () => {
    const root = tmpRoot();
    const base = path.join(root, "deploy");
    assert.equal(withCollisionSuffix(base), base, "free base is returned unchanged");
    fs.mkdirSync(base);
    assert.equal(withCollisionSuffix(base), `${base}-1`);
    fs.mkdirSync(`${base}-1`);
    assert.equal(withCollisionSuffix(base), `${base}-2`);
    assert.equal(fs.existsSync(`${base}-2`), false);
  });

  it("uniqueLocalDistDir nests under a safe id segment", () => {
    const distRoot = tmpRoot();
    const safe = uniqueLocalDistDir(distRoot, "task_ok");
    assert.equal(path.basename(path.dirname(safe)), "task_ok");
    const unsafe = uniqueLocalDistDir(distRoot, "not/task*id");
    assert.equal(path.basename(path.dirname(unsafe)), "task");
  });

  it("root index.html fallback excludes .loam staging from the file count", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>", "utf8");
    fs.mkdirSync(path.join(root, ".loam", "exports"), { recursive: true });
    fs.writeFileSync(path.join(root, ".loam", "exports", "deploy-x.zip"), "zip", "utf8");
    const out = resolveBuildOutput(root);
    assert.ok(out, "root index.html is a valid build output");
    assert.equal(out!.relative, ".");
    assert.equal(out!.fileCount, 1, "staging archives are not counted as build files");
  });

  it("local URL falls back to the dist dir when index.html is absent", async () => {
    const root = tmpRoot();
    const distRoot = path.join(root, "dsite");
    const buildDir = makeBuild(root, { "app.js": "// no index here" });
    const target = createLocalDeployTarget({ distRoot });
    const result = await target.deploy({ buildDir, taskId: "task_noidx" });
    assert.equal(result.ok, true);
    assert.ok(result.url, "a URL is always returned for the local target");
    assert.ok(!result.url!.endsWith("index.html"), "must not point at a missing index.html");
  });

  it("exportBuild throws honestly when nothing is built", () => {
    const root = tmpRoot();
    assert.throws(() => exportBuild(root, "task_none"), /no build output found/);
  });

  it("missingCredentials treats unset and empty values as missing", () => {
    const key = "LOAM_TEST_CREDENTIAL";
    process.env[key] = "1";
    try {
      assert.deepEqual(missingCredentials([key, "LOAM_TEST_ABSENT"]), ["LOAM_TEST_ABSENT"]);
      process.env[key] = "";
      assert.deepEqual(missingCredentials([key]), [key], "empty value counts as missing");
    } finally {
      delete process.env[key];
    }
  });

  it("targetCatalog orders local first and findTarget resolves by id", () => {
    const local = createLocalDeployTarget({ distRoot: tmpRoot() });
    const catalog = targetCatalog(local);
    assert.deepEqual(catalog.map((t) => t.id), ["local", "vercel", "netlify"]);
    assert.equal(findTarget(catalog, "vercel")?.kind, "cloud");
    assert.equal(findTarget(catalog, "nope"), undefined);
    for (const target of catalog) {
      assert.equal(typeof target.describe(), "string");
      assert.ok(target.describe().length > 0);
    }
  });

  it("safeSegment and timestampSegment are deterministic", () => {
    assert.equal(safeSegment("task_ok-1"), "task_ok-1");
    assert.equal(safeSegment("../evil"), "task");
    assert.equal(safeSegment(""), "task");
    assert.equal(safeSegment("a/b"), "task");
    assert.match(timestampSegment(new Date("2026-10-22T01:02:03.004Z")), /^\d{17}$/);
  });

  it("cloud stub deploy methods report the credentials they need", async () => {
    const root = tmpRoot();
    makeBuild(root);
    delete process.env.VERCEL_TOKEN;
    try {
      const vercel = createVercelDeployTarget();
      const result = await vercel.deploy({ buildDir: path.join(root, "dist"), taskId: "task_v" });
      assert.equal(result.ok, false);
      assert.deepEqual(result.missingEnv, ["VERCEL_TOKEN"]);
      assert.equal(result.url, null);
    } finally {
      // leave the environment as we found it
    }
  });

  it("deployBuild local target still throws when nothing is built", async () => {
    const root = tmpRoot();
    await assert.rejects(
      () => deployBuild(root, "task_x", createLocalDeployTarget({ distRoot: path.join(root, "out") })),
      /no build output found/,
    );
  });

  it("directDistWriter copies nested files and skips symlinks", () => {
    const root = tmpRoot();
    const src = path.join(root, "src");
    fs.mkdirSync(path.join(src, "nested"), { recursive: true });
    fs.writeFileSync(path.join(src, "a.txt"), "aaa", "utf8");
    fs.writeFileSync(path.join(src, "nested", "b.txt"), "bbb", "utf8");
    try { fs.symlinkSync("a.txt", path.join(src, "link.txt"), "file"); } catch { /* unsupported FS */ }
    const dest = path.join(root, "dest");
    directDistWriter.write(src, dest);
    assert.equal(fs.readFileSync(path.join(dest, "a.txt"), "utf8"), "aaa");
    assert.equal(fs.readFileSync(path.join(dest, "nested", "b.txt"), "utf8"), "bbb");
    assert.equal(fs.existsSync(path.join(dest, "link.txt")), false, "symlinks are not copied");
  });
});
