/**
 * V1 design eval harness tests.
 *
 * Covers the token linter (clean vs. violating sites, RTL readiness), the
 * pluggable critique mock, the offline build check, fixture loading, the
 * combined score, and the `--self-check` CLI on the bundled fixture site.
 * No model API and no network are touched.
 */
import assert from "node:assert";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { mockDesignCritique } from "../critique.js";
import { checkSiteBuild } from "../buildCheck.js";
import { isRtl, minimalDesignLinter, resolveDirection } from "../tokenLint.js";
import {
  loadDesignFixtures,
  PASS_THRESHOLD,
  runSelfCheck,
  scoreFixture,
  type DesignFixture,
} from "../../scripts/eval-design.js";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROMPTS_DIR = path.join(ROOT, "evals", "design", "prompts");
const FIXTURE_SITE = path.join(ROOT, "evals", "design", "fixtures", "site");
const FIXTURE_DIST = path.join(FIXTURE_SITE, "dist");

const CLEAN_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Clean</title><link rel="stylesheet" href="globals.css" /></head>
  <body class="surface">
    <header><h1>Clean site</h1></header>
    <main><img src="a.svg" alt="diagram" /></main>
  </body>
</html>
`;

const CLEAN_CSS = `:root { --background: oklch(98% 0 0); --font-sans: "Inter", system-ui, sans-serif; }
body { font-family: var(--font-sans); }
h1 { font-family: var(--font-heading); }
`;

function tmpSite(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-eval-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return dir;
}

const BUILD_OK = `import fs from "node:fs";\nimport path from "node:path";\nfs.mkdirSync(path.join(import.meta.dirname, "dist"), { recursive: true });\nfs.writeFileSync(path.join(import.meta.dirname, "dist", "index.html"), "<html></html>");\n`;
const BUILD_FAIL = `throw new Error("build exploded");`;

after(() => {
  fs.rmSync(FIXTURE_DIST, { recursive: true, force: true });
});

describe("locale and direction helpers", () => {
  it("detects RTL locales and defaults direction", () => {
    assert.equal(isRtl("ar"), true);
    assert.equal(isRtl("ar-SA"), true);
    assert.equal(isRtl("en"), false);
    assert.equal(resolveDirection("ar"), "rtl");
    assert.equal(resolveDirection("en"), "ltr");
    assert.equal(resolveDirection("en", "rtl"), "rtl");
  });
});

describe("minimalDesignLinter", () => {
  it("scores a clean site 100 with no issues", async () => {
    const dir = tmpSite({ "index.html": CLEAN_HTML, "globals.css": CLEAN_CSS });
    const result = await minimalDesignLinter().lintSite(dir, { locale: "en" });
    assert.equal(result.score, 100);
    assert.deepEqual(result.issues, []);
    assert.ok(result.metrics.files >= 2);
    assert.equal(result.metrics.rtlReady, true);
  });

  it("flags raw colours, arbitrary px, emoji, gradients and missing alt text", async () => {
    const dir = tmpSite({
      "index.html":
        '<!doctype html><html lang="en"><body class="bg-white text-gray-500 w-[133px]">' +
        '<img src="x.png"><p>Hi \u{1F600}</p><div class="bg-gradient-to-r from-blue-500 to-purple-500"></div></body></html>',
    });
    const result = await minimalDesignLinter().lintSite(dir, { locale: "en" });
    const rules = new Set(result.issues.map((i) => i.rule));
    assert.ok(rules.has("raw-color"));
    assert.ok(rules.has("arbitrary-px"));
    assert.ok(rules.has("emoji-icon"));
    assert.ok(rules.has("gradient"));
    assert.ok(rules.has("missing-alt"));
    assert.ok(result.score < 100);
  });

  it("reports RTL readiness only for RTL locales", async () => {
    const good = tmpSite({ "index.html": '<!doctype html><html lang="ar" dir="rtl"><body class="ms-4">مرحبا</body></html>' });
    const goodResult = await minimalDesignLinter().lintSite(good, { locale: "ar" });
    assert.equal(goodResult.metrics.rtlReady, true);
    assert.ok(!goodResult.issues.some((i) => i.rule.startsWith("rtl")));

    const bad = tmpSite({ "index.html": '<!doctype html><html lang="ar"><body>مرحبا</body></html>' });
    const badResult = await minimalDesignLinter().lintSite(bad, { locale: "ar" });
    assert.equal(badResult.metrics.rtlReady, false);
    assert.ok(badResult.issues.some((i) => i.rule === "rtl-dir"));
    assert.ok(badResult.issues.some((i) => i.rule === "rtl-logical"));
  });
});

describe("mockDesignCritique", () => {
  it("is deterministic and responds to the lint score", async () => {
    const input = {
      siteDir: FIXTURE_SITE,
      fixtureId: "landing",
      prompt: "p",
      locale: "en",
      direction: "ltr" as const,
      lint: { score: 40, issues: [], metrics: { files: 1, rawColors: 0, arbitraryPx: 0, fontFamilies: 1, emoji: 0, gradients: 0, missingAlt: 0, rtlReady: true } },
    };
    const critique = mockDesignCritique();
    const low = await critique.critique(input);
    const again = await critique.critique(input);
    const high = await critique.critique({ ...input, lint: { ...input.lint, score: 100 } });
    assert.deepEqual(low, again);
    assert.ok(high.score > low.score);
    assert.ok(low.dimensions.length >= 7);
  });
});

describe("checkSiteBuild", () => {
  it("passes when a build script exits 0 and produces an artifact", async () => {
    const dir = tmpSite({ "build.mjs": BUILD_OK });
    const result = await checkSiteBuild(dir, { timeoutMs: 30_000 });
    assert.equal(result.pass, true);
    assert.equal(result.artifact, "dist/index.html");
    assert.equal(result.exitCode, 0);
  });

  it("fails when the build command exits non-zero", async () => {
    const dir = tmpSite({ "build.mjs": BUILD_FAIL });
    const result = await checkSiteBuild(dir, { timeoutMs: 30_000 });
    assert.equal(result.pass, false);
    assert.notEqual(result.exitCode, 0);
  });

  it("fails when there is no entrypoint and no prebuilt artifact", async () => {
    const dir = tmpSite({ "index.html": CLEAN_HTML });
    const result = await checkSiteBuild(dir);
    assert.equal(result.pass, false);
  });
});

describe("design eval fixtures", () => {
  it("loads 12 fixtures with the required fields", () => {
    const fixtures = loadDesignFixtures();
    assert.equal(fixtures.length, 12);
    const ids = new Set(fixtures.map((f) => f.id));
    assert.equal(ids.size, 12);
    for (const fixture of fixtures) {
      assert.ok(fixture.id.length > 0);
      assert.ok(fixture.prompt.length > 10);
      assert.ok(fixture.locale.length > 0);
      assert.ok(fixture.direction === "ltr" || fixture.direction === "rtl");
      assert.ok(fixture.expectations);
    }
    const rtl = fixtures.filter((f) => f.direction === "rtl");
    assert.equal(rtl.length, 2);
    assert.ok(rtl.every((f) => f.locale === "ar"));
  });
});

describe("scoreFixture", () => {
  it("combines lint, critique and build into a bounded total", async () => {
    const dir = tmpSite({
      "index.html": '<!doctype html><html lang="en"><head><link rel="stylesheet" href="globals.css" /></head><body><h1>Northlight Roast</h1><a>Start your subscription</a><section>Our roasts</section><img src="b.svg" alt="beans" /></body></html>',
      "globals.css": CLEAN_CSS,
      "build.mjs": BUILD_OK,
    });
    const fixtures = loadDesignFixtures();
    const landing = fixtures.find((f) => f.id === "landing") as DesignFixture;
    const score = await scoreFixture(landing, dir);
    assert.ok(score.total >= 0 && score.total <= 100);
    assert.ok(score.expectations.coverage > 0);
    assert.equal(score.build.pass, true);
    assert.equal(score.verdict, "pass");
  });

  it("fails the verdict when the build does not pass", async () => {
    const dir = tmpSite({ "index.html": CLEAN_HTML, "globals.css": CLEAN_CSS });
    const fixtures = loadDesignFixtures();
    const landing = fixtures.find((f) => f.id === "landing") as DesignFixture;
    const score = await scoreFixture(landing, dir);
    assert.equal(score.build.pass, false);
    assert.equal(score.verdict, "fail");
  });
});

describe("self-check", () => {
  it("scores the bundled fixture site above the pass threshold", async () => {
    const score = await runSelfCheck();
    assert.equal(score.fixtureId, "landing");
    assert.equal(score.build.pass, true);
    assert.ok(score.total >= PASS_THRESHOLD, `total ${score.total} < ${PASS_THRESHOLD}`);
    assert.equal(score.verdict, "pass");
  });

  it("exposes the fixtures via --list", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "src/scripts/eval-design.ts", "--list"], {
      cwd: ROOT,
      timeout: 120_000,
      windowsHide: true,
    });
    const listed = JSON.parse(stdout) as Array<{ id: string }>;
    assert.equal(listed.length, 12);
  });

  it("runs --self-check and emits JSON scores", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/scripts/eval-design.ts", "--self-check", "--json"],
      { cwd: ROOT, timeout: 120_000, windowsHide: true },
    );
    const parsed = JSON.parse(stdout) as { total: number; verdict: string; build: { pass: boolean }; lint: { score: number } };
    assert.equal(parsed.verdict, "pass");
    assert.equal(parsed.build.pass, true);
    assert.ok(parsed.total >= PASS_THRESHOLD);
    assert.equal(parsed.lint.score, 100);
  });
});
