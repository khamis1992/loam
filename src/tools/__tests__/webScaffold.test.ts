/**
 * Tests for web_scaffold (offline Vite + React + Tailwind starter scaffold).
 *
 * Guarantees under test:
 *  - the bundled starter copies in full: ~25 ui components, tokens, RTL support
 *  - RTL readiness: dir support, logical properties and an Arabic font token
 *  - no secrets and no placeholder image URLs in the starter
 *  - existing files are never overwritten unless overwrite=true
 *  - projectDir is confined to the task workspace
 *  - install/build run offline from the npm cache with bounded output
 *  - the generated payload matches the templates/web-app source of truth
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  createWebScaffoldTools,
  scaffoldWebApp,
  type CommandResult,
  type CommandRunner,
} from "../webScaffold.js";
import { WEB_APP_TEMPLATE_FILES } from "../templates/webapp/webAppTemplate.js";
import { collectTemplateFiles, generateWebAppTemplateTs } from "../../scripts/gen-web-app-template.js";

let tmpDir = "";

const ctx = (workspace: string) => ({ cfg: {} as never, workspace, emit: () => {} });

function recordRunner(handlers: Array<CommandResult | ((args: string[]) => CommandResult)>) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    const next = handlers.shift();
    if (typeof next === "function") return next(args);
    return next ?? { code: 0, stdout: "ok", stderr: "" };
  };
  return { calls, runner };
}

function readAll(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (cur: string, prefix: string) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else out.set(rel, entry.name.endsWith(".tsx") || entry.name.endsWith(".ts") ? fs.readFileSync(abs, "utf8") : "");
    }
  };
  walk(dir, "");
  return out;
}

describe("web_scaffold starter payload", () => {
  it("bundles ~25 shadcn-style ui components", () => {
    const ui = WEB_APP_TEMPLATE_FILES.filter((f) => /^src\/components\/ui\/[^/]+\.tsx$/.test(f.path));
    assert.ok(ui.length >= 25, `expected at least 25 ui components, found ${ui.length}`);
    for (const required of ["button", "card", "dialog", "dropdown-menu", "select", "tabs", "tooltip", "table"]) {
      assert.ok(ui.some((f) => f.path === `src/components/ui/${required}.tsx`), `missing ui/${required}.tsx`);
    }
  });

  it("is RTL-ready: dir support, logical properties and an Arabic font token", () => {
    const css = WEB_APP_TEMPLATE_FILES.find((f) => f.path === "src/index.css")!.content;
    assert.match(css, /--font-arabic:/);
    assert.match(css, /:root\[dir="rtl"\] body/);
    assert.match(css, /--color-primary:/);
    const provider = WEB_APP_TEMPLATE_FILES.find((f) => f.path === "src/components/theme-provider.tsx")!.content;
    assert.match(provider, /setAttribute\("dir", direction\)/);
    assert.match(provider, /"rtl"/);
  });

  it("contains no secret-shaped values and no placeholder image URLs", () => {
    const secretPatterns: readonly RegExp[] = [/sk_live_[A-Za-z0-9]{10,}/, /sk_test_[A-Za-z0-9]{10,}/, /eyJ[A-Za-z0-9_-]{20,}/];
    for (const file of WEB_APP_TEMPLATE_FILES) {
      for (const pattern of secretPatterns) {
        assert.ok(!pattern.test(file.content), `${file.path} must not contain secret-shaped data`);
      }
      assert.ok(!/src=["']https?:\/\/example\.com\//.test(file.content), `${file.path} must not use a placeholder image URL`);
    }
  });

  it("keeps .env.example values empty", () => {
    const env = WEB_APP_TEMPLATE_FILES.find((f) => f.path === ".env.example")!.content;
    for (const line of env.split("\n")) {
      if (line && !line.startsWith("#")) assert.match(line, /^[A-Z0-9_]+=$/, `empty value expected: ${line}`);
    }
  });
});

describe("scaffoldWebApp", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-web-scaffold-test-"));
  });
  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("copies every template file with the expected structure", () => {
    const outcome = scaffoldWebApp(tmpDir, WEB_APP_TEMPLATE_FILES);
    assert.equal(outcome.created.length, WEB_APP_TEMPLATE_FILES.length);
    const files = readAll(tmpDir);
    assert.ok(files.has("package.json"));
    assert.ok(files.has("src/main.tsx"));
    assert.ok(files.has("src/App.tsx"));
    assert.ok(files.has("src/index.css"));
    assert.ok(files.has("src/components/ui/button.tsx"));
  });

  it("never overwrites existing files unless overwrite is set", () => {
    const marker = path.join(tmpDir, "package.json");
    fs.writeFileSync(marker, '{"name":"local"}\n', "utf8");
    const first = scaffoldWebApp(tmpDir, WEB_APP_TEMPLATE_FILES);
    assert.equal(fs.readFileSync(marker, "utf8"), '{"name":"local"}\n');
    assert.ok(first.skipped.includes("package.json"));
    scaffoldWebApp(tmpDir, WEB_APP_TEMPLATE_FILES, true);
    assert.match(fs.readFileSync(marker, "utf8"), /"name": "loam-web-app"/);
  });

  it("refuses projectDir that escapes the workspace", async () => {
    const tool = createWebScaffoldTools({ runCommand: async () => ({ code: 0, stdout: "", stderr: "" }) })
      .find((t) => t.name === "web_scaffold")!;
    for (const bad of ["../escape", "..\\escape", "/abs", "C:\\evil", "a/../../b"]) {
      const res = await tool.run({ projectDir: bad, install: false, build: false }, ctx(tmpDir));
      assert.equal(res.ok, false, `expected refusal for ${bad}`);
      assert.match(res.content, /refused/);
    }
    assert.deepEqual(fs.readdirSync(tmpDir), [], "nothing was written outside the workspace");
  });
});

describe("web_scaffold tool run", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-web-scaffold-run-"));
  });
  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("installs offline from the npm cache then builds", async () => {
    const { calls, runner } = recordRunner([{ code: 0, stdout: "added 88 packages", stderr: "" }, { code: 0, stdout: "built in 2s", stderr: "" }]);
    const tool = createWebScaffoldTools({ runCommand: runner }).find((t) => t.name === "web_scaffold")!;
    const res = await tool.run({}, ctx(tmpDir));
    assert.equal(res.ok, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]!.args, ["install", "--offline", "--no-audit", "--no-fund"]);
    assert.deepEqual(calls[1]!.args, ["run", "build"]);
    assert.match(res.content, /npm install --offline/);
    assert.match(res.content, /npm run build/);
    assert.ok(fs.existsSync(path.join(tmpDir, "src", "App.tsx")));
  });

  it("fails when the offline install fails", async () => {
    const { runner } = recordRunner([{ code: 1, stdout: "", stderr: "ENOTCACHED" }]);
    const tool = createWebScaffoldTools({ runCommand: runner }).find((t) => t.name === "web_scaffold")!;
    const res = await tool.run({}, ctx(tmpDir));
    assert.equal(res.ok, false);
    assert.match(res.content, /ENOTCACHED/);
  });

  it("fails when the build fails", async () => {
    const { runner } = recordRunner([
      { code: 0, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "error TS2307" },
    ]);
    const tool = createWebScaffoldTools({ runCommand: runner }).find((t) => t.name === "web_scaffold")!;
    const res = await tool.run({}, ctx(tmpDir));
    assert.equal(res.ok, false);
    assert.match(res.content, /error TS2307/);
  });

  it("copies files only when install and build are disabled", async () => {
    const { calls, runner } = recordRunner([]);
    const tool = createWebScaffoldTools({ runCommand: runner }).find((t) => t.name === "web_scaffold")!;
    const res = await tool.run({ install: false, build: false }, ctx(tmpDir));
    assert.equal(res.ok, true);
    assert.equal(calls.length, 0);
    assert.ok(fs.existsSync(path.join(tmpDir, "package.json")));
  });
});

describe("web-app template generator", () => {
  it("collects sorted POSIX paths and skips node_modules", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-web-gen-"));
    try {
      fs.mkdirSync(path.join(dir, "src", "components", "ui"), { recursive: true });
      fs.mkdirSync(path.join(dir, "node_modules", "react"), { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
      fs.writeFileSync(path.join(dir, "src", "main.tsx"), "main");
      fs.writeFileSync(path.join(dir, "node_modules", "react", "index.js"), "secret");
      const files = collectTemplateFiles(dir);
      assert.deepEqual(
        files.map((f) => f.path),
        ["package.json", "src/main.tsx"],
      );
      const source = generateWebAppTemplateTs(files);
      assert.match(source, /AUTO-GENERATED by src\/scripts\/gen-web-app-template\.ts/);
      assert.match(source, /WEB_APP_TEMPLATE_FILES/);
      assert.ok(!source.includes("node_modules"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
