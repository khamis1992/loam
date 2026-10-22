/**
 * Design eval harness (V1).
 *
 * Scores a generated site directory against the Loam design eval set:
 *   total = 0.5 * lint + 0.3 * critique + 0.2 * build
 *
 * - lint: token linter behind the {@link DesignLinter} interface (V4 extends it).
 * - critique: pluggable rubric; the default is the deterministic offline mock.
 * - build: exit-0 build plus a verified output artifact.
 *
 * Usage:
 *   tsx src/scripts/eval-design.ts --self-check
 *   tsx src/scripts/eval-design.ts --site ./out --fixture landing --json
 *   tsx src/scripts/eval-design.ts --site ./out --list
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkSiteBuild, type BuildResult } from "../design/buildCheck.js";
import { mockDesignCritique, type CritiqueExpectations, type CritiqueResult, type DesignCritique } from "../design/critique.js";
import { isRtl, minimalDesignLinter, type DesignLinter, type LintResult } from "../design/tokenLint.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROMPTS_DIR = path.join(ROOT, "evals", "design", "prompts");
const FIXTURE_SITE_DIR = path.join(ROOT, "evals", "design", "fixtures", "site");

export interface DesignExpectations {
  must?: string[];
  mustNot?: string[];
  keywords?: string[];
  minLint?: number;
  rtl?: boolean;
}

export interface DesignFixture {
  id: string;
  prompt: string;
  locale: string;
  direction: "ltr" | "rtl";
  expectations: DesignExpectations;
}

export interface ExpectationReport {
  checked: string[];
  satisfied: string[];
  missing: string[];
  coverage: number;
}

export interface ScoreDeps {
  linter?: DesignLinter;
  critique?: DesignCritique;
  /** Skip the build check when false. */
  build?: boolean;
}

export interface DesignScore {
  fixtureId: string;
  locale: string;
  direction: "ltr" | "rtl";
  lint: LintResult;
  critique: CritiqueResult;
  build: BuildResult;
  expectations: ExpectationReport;
  total: number;
  verdict: "pass" | "fail";
}

export const PASS_THRESHOLD = 60;

export function loadDesignFixtures(dir: string = PROMPTS_DIR): DesignFixture[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  const fixtures: DesignFixture[] = [];
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>;
    const id = typeof raw["id"] === "string" ? raw["id"] : path.basename(file, ".json");
    const prompt = typeof raw["prompt"] === "string" ? raw["prompt"] : "";
    const locale = typeof raw["locale"] === "string" ? raw["locale"] : "en";
    const explicit = raw["direction"] === "rtl" || raw["direction"] === "ltr" ? raw["direction"] : undefined;
    fixtures.push({
      id,
      prompt,
      locale,
      direction: explicit ?? (isRtl(locale) ? "rtl" : "ltr"),
      expectations: (raw["expectations"] as DesignExpectations) ?? {},
    });
  }
  return fixtures;
}

function findFixture(fixtures: DesignFixture[], id: string): DesignFixture | undefined {
  return fixtures.find((fixture) => fixture.id === id);
}

function readBuiltText(siteDir: string): string {
  const chunks: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full);
      } else if (/\.(html|css|js|mjs|cjs|ts|tsx|jsx|json|txt)$/i.test(entry.name)) {
        try {
          chunks.push(fs.readFileSync(full, "utf8"));
        } catch {
          /* ignore unreadable files */
        }
      }
    }
  };
  walk(path.resolve(siteDir));
  return chunks.join("\n");
}

function evaluateExpectations(fixture: DesignFixture, siteDir: string): ExpectationReport {
  const text = readBuiltText(siteDir);
  const haystack = text.toLowerCase();
  const must = fixture.expectations.must ?? [];
  const mustNot = fixture.expectations.mustNot ?? [];
  const checked = [...must, ...mustNot];
  const satisfied: string[] = [];
  const missing: string[] = [];
  for (const item of must) {
    if (haystack.includes(item.toLowerCase())) satisfied.push(item);
    else missing.push(item);
  }
  for (const item of mustNot) {
    if (!haystack.includes(item.toLowerCase())) satisfied.push(`not:${item}`);
    else missing.push(`not:${item}`);
  }
  const coverage = checked.length === 0 ? 1 : satisfied.length / checked.length;
  return { checked, satisfied, missing, coverage };
}

export async function scoreFixture(fixture: DesignFixture, siteDir: string, deps: ScoreDeps = {}): Promise<DesignScore> {
  const linter = deps.linter ?? minimalDesignLinter();
  const critiqueImpl = deps.critique ?? mockDesignCritique();

  const lint = await linter.lintSite(siteDir, { locale: fixture.locale, direction: fixture.direction });
  const expectations = evaluateExpectations(fixture, siteDir);
  const critiqueExpectations: CritiqueExpectations = {
    must: fixture.expectations.must,
    mustNot: fixture.expectations.mustNot,
    coverage: expectations.coverage,
  };
  const critique = await critiqueImpl.critique({
    siteDir,
    fixtureId: fixture.id,
    prompt: fixture.prompt,
    locale: fixture.locale,
    direction: fixture.direction,
    lint,
    expectations: critiqueExpectations,
  });
  const build = deps.build === false ? { pass: false, command: "skipped", exitCode: null, output: "", artifact: null } : await checkSiteBuild(siteDir);

  const total = Math.round(lint.score * 0.5 + critique.score * 0.3 + (build.pass ? 100 : 0) * 0.2);
  const minLint = fixture.expectations.minLint;
  const lintBarMet = minLint === undefined || lint.score >= minLint;
  const verdict: DesignScore["verdict"] = total >= PASS_THRESHOLD && build.pass && lintBarMet ? "pass" : "fail";

  return { fixtureId: fixture.id, locale: fixture.locale, direction: fixture.direction, lint, critique, build, expectations, total, verdict };
}

/** Run the bundled fixture site through the landing fixture. */
export async function runSelfCheck(): Promise<DesignScore> {
  const fixtures = loadDesignFixtures();
  const fixture = findFixture(fixtures, "landing") ?? fixtures[0];
  if (!fixture) throw new Error("no design fixtures found");
  return scoreFixture(fixture, FIXTURE_SITE_DIR);
}

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i] ?? "";
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}`) {
      const next = process.argv[i + 1];
      return next && !next.startsWith("--") ? next : "true";
    }
  }
  return undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const json = has("json");
  const selfCheck = has("self-check");
  const noBuild = has("no-build");
  const list = has("list");
  const critiqueMode = flag("critique") ?? "mock";
  const threshold = Number(flag("threshold") ?? PASS_THRESHOLD) || PASS_THRESHOLD;

  const fixtures = loadDesignFixtures();
  if (list) {
    const payload = fixtures.map((f) => ({ id: f.id, locale: f.locale, direction: f.direction }));
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (fixtures.length === 0) {
    console.error(`no design fixtures found in ${PROMPTS_DIR}`);
    process.exitCode = 1;
    return;
  }

  let selected: DesignFixture[];
  let siteDir: string | undefined;

  if (selfCheck || (!has("site") && !flag("fixture"))) {
    const score = await runSelfCheck();
    if (json) console.log(JSON.stringify(score, null, 2));
    else {
      console.log(`self-check fixture=${score.fixtureId} lint=${score.lint.score} critique=${score.critique.score} build=${score.build.pass ? 100 : 0} total=${score.total} verdict=${score.verdict}`);
    }
    process.exitCode = score.total >= threshold && score.verdict === "pass" ? 0 : 1;
    return;
  }

  siteDir = flag("site");
  if (!siteDir) {
    console.error("--site is required when not running --self-check");
    process.exit(1);
  }

  const fixtureArg = flag("fixture");
  if (fixtureArg) {
    const fixturePath = path.isAbsolute(fixtureArg) ? fixtureArg : path.join(PROMPTS_DIR, fixtureArg);
    if (fs.existsSync(fixturePath) && fs.statSync(fixturePath).isFile()) {
      const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
      const locale = typeof raw["locale"] === "string" ? raw["locale"] : "en";
      selected = [{
        id: typeof raw["id"] === "string" ? raw["id"] : path.basename(fixturePath, ".json"),
        prompt: typeof raw["prompt"] === "string" ? raw["prompt"] : "",
        locale,
        direction: raw["direction"] === "rtl" || raw["direction"] === "ltr" ? raw["direction"] : isRtl(locale) ? "rtl" : "ltr",
        expectations: (raw["expectations"] as DesignExpectations) ?? {},
      }];
    } else {
      const found = findFixture(fixtures, fixtureArg);
      if (!found) {
        console.error(`unknown fixture: ${fixtureArg}`);
        process.exit(1);
      }
      selected = [found];
    }
  } else {
    selected = fixtures;
  }

  const critiqueImpl: DesignCritique | undefined = critiqueMode === "none" ? undefined : mockDesignCritique();
  const scores: DesignScore[] = [];
  for (const fixture of selected) {
    const score = await scoreFixture(fixture, siteDir, { critique: critiqueImpl, build: !noBuild });
    scores.push(score);
    if (!json) {
      console.log(`[${fixture.id}] lint=${score.lint.score} critique=${score.critique.score} build=${score.build.pass ? 100 : 0} total=${score.total} ${score.verdict.toUpperCase()}`);
    }
  }

  if (json) console.log(JSON.stringify({ threshold, scores }, null, 2));
  const failed = scores.some((s) => s.total < threshold || s.verdict !== "pass");
  process.exitCode = failed ? 1 : 0;
}

void main().catch((error) => {
  console.error(`eval:design failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
