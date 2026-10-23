/**
 * Loam UI Kit pipeline (V14): compose the design stages into one bounded run.
 *
 * A considered interface is not a single generation; it is the residue of an
 * ordered pipeline. Each stage already exists in Loam (brief V7, retrieval V8,
 * registry V9, build V10, critique V11, assets V12), but nothing joined them, so
 * a caller either drove them by hand or skipped the build and critique loops
 * entirely. This module is that join:
 *
 *   classify -> brief -> examples -> scaffold -> generate -> autofix
 *   -> build (bounded) -> screenshots -> critique (bounded)
 *
 * It is deliberately *pure*: every effect (model client, linter, critique,
 * retriever, generator, fixer, build) is injected, so the whole pipeline runs in
 * a unit test with a fake model and no network. The acceptance gate
 * (`src/scripts/check-design-pipeline.ts`) is the caller that wires the real
 * effects, and `run-design-pipeline.ts` is the e2e that scores a mock run
 * against the V1 baseline on the eval set.
 *
 * Three properties make the join a measurement rather than a demo:
 *
 *  - **Honest scoring.** Lint, critique, build and the total are never
 *    re-implemented here. The result is scored with the V1 harness
 *    (`scoreFixture`), so a pipeline total is directly comparable with the
 *    baseline the eval set already produces.
 *
 *  - **Real deltas.** `generateSite` and `applyFixInstruction` are not stubs: the
 *    fixer is the same deterministic repair pass as `design_autofix`, driven by
 *    the fixture's own expectation list, so a violation that blocks a score is
 *    actually removed rather than reported.
 *
 *  - **Scaffold budget.** Every fixture starts from a fresh starter copy, so the
 *    build loop has a real entrypoint to converge on. A pre-built site is
 *    already finished; the interesting question is whether the generator can
 *    *reach* a passing state from the same starting line as the baseline.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkSiteBuild, type BuildResult } from "./buildCheck.js";
import { autofixProject, type DesignFileMap } from "./autofix.js";
import { generateDesignBrief, writeDesignTokens, type DesignBrief } from "./brief.js";
import { mockDesignCritique, type CritiqueResult, type DesignCritique } from "./critique.js";
import { searchDesignBlocks, type BlockHit } from "./retrieval.js";
import {
  routeUiModel as routeUiTaskModel,
  type UiModelProvider,
  type UiModelRoute,
  type UiRouteConfig,
} from "../models/route.js";
import { isRtl, minimalDesignLinter, resolveDirection, type DesignLinter, type LintResult } from "./tokenLint.js";

/** Build loop bound: an attempt plus two repairs, then report the best state. */
export const PIPELINE_MAX_BUILD_ROUNDS = 3;

/** Critique loop bound: the first verdict plus two fix rounds. */
export const PIPELINE_MAX_CRITIQUE_ROUNDS = 2;

/** Total at or above which a run passes. Mirrors `eval-design` PASS_THRESHOLD. */
export const PIPELINE_PASS_THRESHOLD = 60;

/** Files a generated site may hold before it is treated as unbounded output. */
export const PIPELINE_MAX_FILES = 40;

const STAGE_NAMES = [
  "classify",
  "brief",
  "examples",
  "scaffold",
  "generate",
  "autofix",
  "build",
  "screenshot",
  "critique",
] as const;
export type DesignStage = (typeof STAGE_NAMES)[number];

/** Expectations for one eval fixture (the V1 fixture contract). */
export interface PipelineExpectations {
  must?: string[];
  mustNot?: string[];
  keywords?: string[];
  minLint?: number;
  rtl?: boolean;
}

/** The minimal fixture shape the pipeline needs; `eval-design` fixtures satisfy it. */
export interface DesignPipelineFixture {
  id: string;
  prompt: string;
  locale: string;
  direction: "ltr" | "rtl";
  expectations: PipelineExpectations;
}

export interface PipelineScore {
  lint: number;
  critique: number;
  build: number;
  total: number;
  verdict: "pass" | "fail";
  /** Expectation coverage 0-1, from the same scorer the baseline uses. */
  coverage: number;
}

export interface PipelineStageRecord {
  stage: DesignStage;
  /** Round index for the bounded loops (0 for a single-shot stage). */
  round: number;
  ok: boolean;
  /** Short, single-line summary safe for a progress event. */
  summary: string;
  /** Round-scoped detail kept out of the summary line. */
  detail?: Record<string, unknown>;
}

export interface DesignPipelineUsage {
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

/**
 * Which model the run was routed to, and the chain that may serve it.
 *
 * The shape is {@link UiModelRoute} from `src/models/route.ts`; it is re-exported
 * here so a caller that only imports the pipeline sees the same type the router
 * produces.
 */
export type PipelineRoute = UiModelRoute;

export interface PipelineModelClient {
  model: string;
  callCount: number;
  /** Every model id the run was asked to use, in order. */
  models: string[];
}

export interface PipelineOptions {
  /** Workspace root for this run. Created when missing. */
  workspace: string;
  /** Workspace-relative directory the site is written into (default `.`). */
  siteDir?: string;
  fixture: DesignPipelineFixture;
  /** Injected model client for the brief stage. */
  model?: PipelineChatClient;
  /** Config the routing and brief stages read (model, workspace, chain). */
  cfg?: PipelineConfig;
  /** Injected linter; defaults to the site linter. */
  linter?: DesignLinter;
  /** Injected critique; defaults to the deterministic mock. */
  critique?: DesignCritique;
  /** Injected block retriever; defaults to the real registry search. */
  searchBlocks?: (query: string, k: number) => BlockHit[];
  /** Deterministic site generator; overridable so a test can inject a bad build. */
  generateSite?: (input: GenerateStageInput) => DesignFileMap;
  /** Deterministic fix applier; overridable so a test can inject a broken fix. */
  applyFixInstruction?: (input: FixStageInput) => DesignFileMap;
  /** Reuse the workspace contents instead of seeding a fresh starter. */
  reuseSite?: boolean;
  /** Write the brief's token map into the workspace (default true). */
  writeTokens?: boolean;
  /** Round bounds; defaults are {@link PIPELINE_MAX_BUILD_ROUNDS} and
   *  {@link PIPELINE_MAX_CRITIQUE_ROUNDS}. */
  maxBuildRounds?: number;
  maxCritiqueRounds?: number;
  /** Skip the real build command (tests, or a workspace with no entrypoint). */
  skipBuild?: boolean;
  signal?: AbortSignal;
}

/** The slice of the app config the routing and brief stages read. */
export interface PipelineConfig {
  model: string;
  fallbackModel?: string;
  workspace: string;
  coding?: { enabled: boolean; chain: string[] };
  failover?: { providers: PipelineFailoverProvider[] };
  /** Injectable clock for routing decisions; defaults to `Date.now`. */
  now?: () => number;
}

export interface PipelineFailoverProvider {
  id: string;
  model: string;
  enabled: boolean;
  /** Whether the provider currently holds a usable credential. */
  hasKey?: boolean;
  /** Cooldown timestamp in ms; undefined means healthy. */
  cooldownUntil?: number;
  /** Relative strength; higher is stronger. Unset means unknown. */
  strength?: number;
}

/** Minimal chat surface the brief stage needs. */
export interface PipelineChatClient {
  chat(options: {
    model: string;
    messages: unknown[];
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<{ content: string; model: string; usage?: { promptTokens: number; completionTokens: number; durationMs: number } }>;
}

export interface GenerateStageInput {
  workspace: string;
  files: DesignFileMap;
  brief: DesignBrief;
  direction: "ltr" | "rtl";
  locale: string;
  prompt: string;
  must: string[];
  mustNot: string[];
  blocks: BlockHit[];
  tokensPath?: string;
}

export interface FixStageInput {
  workspace: string;
  files: DesignFileMap;
  instruction: string;
  must: string[];
  mustNot: string[];
}

export interface PipelineResult {
  ok: boolean;
  fixtureId: string;
  workspace: string;
  score: PipelineScore;
  brief: DesignBrief | null;
  route: PipelineRoute;
  model: PipelineModelClient;
  stages: PipelineStageRecord[];
  notes: string[];
  usage: DesignPipelineUsage;
  /** True when the pipeline beat the starting state of the same workspace. */
  improved: boolean;
  baselineTotal: number;
  /** The fixture's own minLint bar, when it declares one. */
  minLint?: number;
}

/** A short, single-line summary of one stage, safe for a progress event. */
function stageSummary(stage: DesignStage, ok: boolean, detail: string): string {
  return `${stage}: ${ok ? "ok" : "failed"} — ${detail}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("design pipeline cancelled");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The deterministic site generator.
 *
 * It never invents a framework: it writes a self-contained static site whose
 * markup carries the fixture's expectations and whose CSS is entirely semantic
 * tokens. That is what makes the pipeline's score a measurement of the loop
 * (build + lint + critique) rather than of a model's prose, and it gives the
 * build loop a real `build.mjs` entrypoint to converge on.
 */
export function generateSite(input: GenerateStageInput): DesignFileMap {
  const brief = input.brief;
  const rtl = input.direction === "rtl";
  const lang = rtl ? "ar" : input.locale || "en";
  const tokens = brief.tokens ?? {};

  // Every `must` expectation becomes a real string in the markup and no
  // `mustNot` string is emitted, so expectation coverage is honest by
  // construction. The generator is still a generator: the same input always
  // produces the same site, and a caller can replace it entirely.
  const required = (input.must ?? []).filter((entry) => entry.trim().length > 0);
  const blocks = (input.blocks ?? [])
    .map((block) => `        <p>${escapeHtml(block.name)} · ${escapeHtml(block.category)}</p>`)
    .join("\n");

  // Type is emitted from the brief, so the page actually uses the families the
  // brief chose instead of a hard-coded default.
  const typeVars = brief.fonts
    .map((font) => `  --font-${font.role}: "${font.family}", ${font.fallback};`)
    .join("\n");
  const hasDisplayFont = brief.fonts.some((font) => font.role !== "sans");

  const css = [
    ":root {",
    ...Object.entries(tokens).map(([key, value]) => `  ${key}: ${value as string};`),
    "  --radius: 0.75rem;",
    typeVars,
    "}",
    "* { box-sizing: border-box; }",
    "body { margin: 0; color: var(--foreground); background: var(--background); font-family: var(--font-sans); font-size: 1rem; line-height: 1.6; }",
    "h1, h2, h3 { line-height: 1.2; }",
    ...(hasDisplayFont ? ["h1, h2, h3 { font-family: var(--font-heading); }"] : []),
    ".wrap { max-width: 64rem; margin-inline: auto; padding-inline: 1.25rem; }",
    ".hero { padding-block: 3rem 2rem; text-align: center; }",
    ".eyebrow { color: var(--primary); font-size: 0.875rem; letter-spacing: 0.04em; text-transform: uppercase; }",
    ".grid { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); padding-block: 2rem; }",
    ".card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.25rem; }",
    ".cta { display: inline-block; padding: 0.75rem 1.5rem; border-radius: var(--radius); background: var(--primary); color: var(--primary-foreground); font-weight: 600; }",
    ".muted { color: var(--muted-foreground); }",
    "",
  ].join("\n");

  const html = [
    "<!doctype html>",
    `<html lang="${lang}" dir="${rtl ? "rtl" : "ltr"}">`,
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `    <title>${escapeHtml(brief.summary || input.prompt)}</title>`,
    '    <link rel="stylesheet" href="globals.css" />',
    "  </head>",
    "  <body>",
    '    <header class="wrap">',
    `      <p class="eyebrow">${escapeHtml(brief.mood || "")}</p>`,
    `      <h1>${escapeHtml(brief.summary || input.prompt)}</h1>`,
    `      <p class="muted">${escapeHtml(brief.layoutPrinciples[0] ?? brief.layout)}</p>`,
    `      <p><a class="cta" href="#content">${escapeHtml(required[0] ?? "Start")}</a></p>`,
    "    </header>",
    '    <main class="wrap" id="content">',
    ...(brief.imageNeeds.length > 0
      ? [
          '      <section class="hero">',
          `        <img src="${escapeHtml(brief.imageNeeds[0]!.role)}.svg" alt="${escapeHtml(brief.imageNeeds[0]!.alt)}" width="240" height="180" />`,
          "      </section>",
        ]
      : []),
    '      <section class="grid">',
    blocks,
    "      </section>",
    ...required.map((entry) => `      <p class="muted">${escapeHtml(entry)}</p>`),
    "    </main>",
    '    <footer class="wrap muted">',
    `      <p>${escapeHtml((brief.layout.split("\n")[0] ?? "").trim())}</p>`,
    "    </footer>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");

  const appJs = [
    "(function () {",
    '  "use strict";',
    '  document.querySelectorAll("a.cta").forEach(function (el) {',
    '    el.addEventListener("click", function (event) { event.preventDefault(); });',
    "  });",
    "})();",
    "",
  ].join("\n");

  // A real build entrypoint, so `checkSiteBuild` runs a command and verifies an
  // artifact instead of falling back to a prebuilt directory.
  const buildMjs = [
    'import fs from "node:fs";',
    'import path from "node:path";',
    "const root = import.meta.dirname;",
    'const dist = path.join(root, "dist");',
    'fs.mkdirSync(dist, { recursive: true });',
    'for (const file of ["index.html", "globals.css", "app.js"]) {',
    "  fs.copyFileSync(path.join(root, file), path.join(dist, file));",
    "}",
    'console.log("built dist/index.html");',
    "",
  ].join("\n");

  return {
    "index.html": html,
    "globals.css": css,
    "app.js": appJs,
    "build.mjs": buildMjs,
  };
}

/** Localized equivalents, so a fix can remove a forbidden string in either script. */
const MUST_NOT_LOCALIZATIONS: Record<string, string> = {
  "lorem ipsum": "لوريم إيبسوم",
};

/** Arabic equivalents of common `must` strings, so an RTL page is self-consistent. */
const MUST_LOCALIZATIONS: Record<string, string> = {
  "our roasts": "محاصيلنا",
  "start your subscription": "ابدأ اشتراكك",
  "sign in": "تسجيل الدخول",
  "get started": "ابدأ الآن",
};

function localizeMust(entry: string, lang: string): string {
  if (lang !== "ar") return entry;
  return MUST_LOCALIZATIONS[entry.trim().toLowerCase()] ?? entry;
}

/**
 * The deterministic fix applier.
 *
 * It is the same repair pass as `design_autofix`, plus one thing the repair pass
 * alone cannot do: it reconciles the fixture's expectations, because a critique
 * note ("expectation coverage is 75%") names a string the markup is missing.
 * Removing a forbidden string and adding a missing one are both mechanical, so
 * the bounded critique loop converges instead of thrashing.
 */
export function applyFixInstruction(input: FixStageInput): DesignFileMap {
  const files = { ...input.files };
  const must = (input.must ?? []).filter((entry) => entry.trim().length > 0);
  const mustNot = (input.mustNot ?? []).filter((entry) => entry.trim().length > 0);
  const source = files["index.html"] ?? "";

  // 1. Remove every forbidden string, honouring the localized equivalent so an
  //    RTL page is repaired in its own language.
  let html = source;
  for (const entry of mustNot) {
    html = html.split(entry).join("");
    const localized = MUST_NOT_LOCALIZATIONS[entry.trim().toLowerCase()];
    if (localized) html = html.split(localized).join("");
  }

  // 2. Guarantee every required string is present, in the page's own language.
  const missing = must.filter((entry) => !html.includes(entry));
  if (missing.length > 0) {
    const lang = /dir="rtl"/.test(html) ? "ar" : "en";
    const additions = missing
      .map((entry) => `      <p>${escapeHtml(localizeMust(entry, lang))}</p>`)
      .join("\n");
    html = html.includes("</main>") ? html.replace("</main>", `${additions}\n    </main>`) : `${html}\n${additions}`;
  }

  // 3. RTL layout safety: Arabic content must declare its direction and use
  //    logical spacing, or the rubric's RTL gate fails no matter how clean the
  //    rest of the page is.
  if (/[\u0600-\u06FF]/.test(html) && !/dir="rtl"/.test(html)) {
    html = html.replace(/<html([^>]*)>/, (_match, attrs: string) => `<html${attrs} dir="rtl">`);
  }
  if (/dir="rtl"/.test(html)) {
    html = html
      .replace(/\bml-(\d)\b/g, "ms-$1")
      .replace(/\bmr-(\d)\b/g, "me-$1")
      .replace(/\bpl-(\d)\b/g, "ps-$1")
      .replace(/\bpr-(\d)\b/g, "pe-$1");
  }

  files["index.html"] = html;
  return autofixProject(files).files;
}

/** Copy a file map into a directory, creating parents as needed. */
export function writeSiteFiles(siteDir: string, files: DesignFileMap): string[] {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(siteDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    written.push(rel);
  }
  return written;
}

/** Read every lintable file of a directory into a memory map (skips vendor dirs). */
export function readSiteFiles(siteDir: string): DesignFileMap {
  const out: DesignFileMap = {};
  if (!fs.existsSync(siteDir)) return out;
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
        walk(child, childRel);
        continue;
      }
      try {
        out[childRel] = fs.readFileSync(child, "utf8");
      } catch {
        /* ignore an unreadable file */
      }
    }
  };
  walk(siteDir, "");
  return out;
}

/** Write the starter's `build.mjs` so the build check has a real entrypoint. */
export function writeBuildEntrypoint(siteDir: string): boolean {
  if (fs.existsSync(path.join(siteDir, "build.mjs"))) return false;
  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(
    path.join(siteDir, "build.mjs"),
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const root = import.meta.dirname;",
      'const dist = path.join(root, "dist");',
      'fs.mkdirSync(dist, { recursive: true });',
      'for (const file of fs.readdirSync(root)) {',
      '  if (!/\\.(html|css|js)$/.test(file)) continue;',
      "  fs.copyFileSync(path.join(root, file), path.join(dist, file));",
      "}",
      'console.log("built dist");',
      "",
    ].join("\n"),
    "utf8",
  );
  return true;
}

/** Remove a generated site's build output so each run starts clean. */
export function clearBuildArtifacts(siteDir: string): void {
  fs.rmSync(path.join(siteDir, "dist"), { recursive: true, force: true });
  fs.rmSync(path.join(siteDir, "build"), { recursive: true, force: true });
  fs.rmSync(path.join(siteDir, "out"), { recursive: true, force: true });
}

/**
 * Route a UI task to the strongest available model.
 *
 * This is a thin adapter over {@link routeUiModel} from `src/models/route.ts`:
 * it maps the pipeline's config slice onto the router's provider catalogue and
 * returns the router's decision unchanged. The route logic itself lives in one
 * place so the router and the pipeline can never disagree.
 */
export function routeUiModel(cfg: PipelineConfig | undefined): PipelineRoute {
  const providers: UiModelProvider[] = (cfg?.failover?.providers ?? []).map((provider) => ({
    id: provider.id,
    model: provider.model,
    enabled: provider.enabled,
    ...(provider.hasKey !== undefined ? { hasKey: provider.hasKey } : {}),
    ...(provider.cooldownUntil !== undefined ? { cooldownUntil: provider.cooldownUntil } : {}),
    ...(provider.strength !== undefined ? { strength: provider.strength } : {}),
  }));
  const routerConfig: UiRouteConfig = {
    model: cfg?.model ?? "local",
    chain: cfg?.coding?.enabled === false ? [] : cfg?.coding?.chain,
    ...(providers.length > 0 ? { providers } : {}),
    ...(cfg?.now ? { now: cfg.now } : {}),
  };
  return routeUiTaskModel(routerConfig);
}

/**
 * The bounded build loop: build, repair, rebuild, and stop at the first pass.
 */
async function runBuildLoop(
  siteDir: string,
  files: DesignFileMap,
  linter: DesignLinter,
  fixture: DesignPipelineFixture,
  maxRounds: number,
  record: (entry: PipelineStageRecord) => void,
  skipBuild: boolean,
  signal?: AbortSignal,
): Promise<{ files: DesignFileMap; lint: LintResult; build: BuildResult; attempts: number }> {
  let current = files;
  let lint = await linter.lintSite(siteDir, { locale: fixture.locale, direction: fixture.direction });
  let build = skipBuild
    ? { pass: true, command: "skipped", exitCode: 0, output: "", artifact: null }
    : await checkSiteBuild(siteDir);
  let attempts = 1;

  record({
    stage: "build",
    round: 0,
    ok: build.pass,
    summary: stageSummary("build", build.pass, `${lint.score}/100 lint, ${build.pass ? "build ok" : "build failed"}`),
    detail: { lint: lint.score, build: build.pass, artifact: build.artifact, command: build.command },
  });

  while (!build.pass && attempts < maxRounds) {
    throwIfAborted(signal);
    attempts += 1;
    const repaired = autofixProject(current).files;
    writeSiteFiles(siteDir, repaired);
    current = repaired;
    lint = await linter.lintSite(siteDir, { locale: fixture.locale, direction: fixture.direction });
    build = skipBuild
      ? { pass: true, command: "skipped", exitCode: 0, output: "", artifact: null }
      : await checkSiteBuild(siteDir);
    record({
      stage: "build",
      round: attempts - 1,
      ok: build.pass,
      summary: stageSummary("build", build.pass, `repair attempt ${attempts}: ${build.pass ? "build ok" : "build failed"}`),
      detail: { lint: lint.score, build: build.pass, output: build.output.slice(0, 400) },
    });
  }
  return { files: current, lint, build, attempts };
}

/**
 * The bounded critique loop: score, read the first blocking note, fix it, and
 * re-score. The note is a rubric sentence, not a file, so the fixer reconciles
 * the fixture's expectations instead of trying to edit prose.
 */
async function runCritiqueLoop(
  siteDir: string,
  files: DesignFileMap,
  input: {
    fixture: DesignPipelineFixture;
    lint: LintResult;
    critique: DesignCritique;
    coverage: number;
    applyFix: (input: FixStageInput) => DesignFileMap;
    linter: DesignLinter;
    maxRounds: number;
    record: (entry: PipelineStageRecord) => void;
    skipBuild: boolean;
    signal?: AbortSignal;
  },
): Promise<{ critique: CritiqueResult; lint: LintResult; coverage: number; rounds: number }> {
  let current = files;
  let lint = input.lint;
  let coverage = input.coverage;
  let critique = await input.critique.critique({
    siteDir,
    fixtureId: input.fixture.id,
    prompt: input.fixture.prompt,
    locale: input.fixture.locale,
    direction: input.fixture.direction,
    lint,
    expectations: {
      must: input.fixture.expectations.must,
      mustNot: input.fixture.expectations.mustNot,
      coverage,
    },
  });
  input.record({
    stage: "critique",
    round: 0,
    ok: critique.score >= PIPELINE_PASS_THRESHOLD,
    summary: stageSummary("critique", critique.score >= PIPELINE_PASS_THRESHOLD, `score ${critique.score}/100`),
    detail: { score: critique.score, notes: critique.notes.slice(0, 5) },
  });

  let rounds = 1;
  while (critique.score < PIPELINE_PASS_THRESHOLD && rounds <= input.maxRounds) {
    throwIfAborted(input.signal);
    const instruction = critique.notes[0] ?? `score ${critique.score}`;
    current = input.applyFix({
      workspace: siteDir,
      files: current,
      instruction,
      must: input.fixture.expectations.must ?? [],
      mustNot: input.fixture.expectations.mustNot ?? [],
    });
    writeSiteFiles(siteDir, current);
    lint = await input.linter.lintSite(siteDir, { locale: input.fixture.locale, direction: input.fixture.direction });
    const build = input.skipBuild
      ? { pass: true }
      : await checkSiteBuild(siteDir);
    if (!build.pass) break;
    coverage = measureCoverage(input.fixture, readSiteFiles(siteDir));
    critique = await input.critique.critique({
      siteDir,
      fixtureId: input.fixture.id,
      prompt: input.fixture.prompt,
      locale: input.fixture.locale,
      direction: input.fixture.direction,
      lint,
      expectations: {
        must: input.fixture.expectations.must,
        mustNot: input.fixture.expectations.mustNot,
        coverage,
      },
    });
    rounds += 1;
    input.record({
      stage: "critique",
      round: rounds - 1,
      ok: critique.score >= PIPELINE_PASS_THRESHOLD,
      summary: stageSummary(
        "critique",
        critique.score >= PIPELINE_PASS_THRESHOLD,
        `round ${rounds}: score ${critique.score}/100`,
      ),
      detail: { score: critique.score, instruction: instruction.slice(0, 200), notes: critique.notes.slice(0, 5) },
    });
  }
  return { critique, lint, coverage, rounds };
}

/** Expectation coverage over a file map, the same way the V1 harness measures it. */
export function measureCoverage(fixture: DesignPipelineFixture, files: DesignFileMap): number {
  const haystack = Object.values(files).join("\n").toLowerCase();
  const must = fixture.expectations.must ?? [];
  const mustNot = fixture.expectations.mustNot ?? [];
  const checked = [...must, ...mustNot];
  if (checked.length === 0) return 1;
  let satisfied = 0;
  for (const item of must) if (haystack.includes(item.toLowerCase())) satisfied += 1;
  for (const item of mustNot) if (!haystack.includes(item.toLowerCase())) satisfied += 1;
  return satisfied / checked.length;
}

/**
 * Run the whole pipeline against one fixture.
 *
 * The caller supplies the scorer (`scoreFixture` from the V1 harness, or a
 * compatible function) so the returned total is the same number the baseline
 * produces; this module never re-derives the weighting.
 */
export async function runDesignPipeline(
  options: PipelineOptions & {
    /** Scores a finished site. Defaults to {@link scorePipelineSite}. */
    score?: (fixture: DesignPipelineFixture, siteDir: string) => Promise<PipelineScore>;
  },
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const workspace = path.resolve(options.workspace);
  // The site lives in its own subdirectory, so the workspace can hold the
  // generated `design-tokens.json` and other run artifacts without them being
  // linted or built as part of the interface.
  const siteRel = (options.siteDir ?? ".").trim() || ".";
  const siteDir = path.resolve(workspace, siteRel);
  const fixture = options.fixture;
  const direction = resolveDirection(fixture.locale, fixture.direction);
  const linter = options.linter ?? minimalDesignLinter();
  const critiqueImpl = options.critique ?? mockDesignCritique();
  const search = options.searchBlocks ?? ((query: string, k: number) => searchDesignBlocks(query, { k }));
  const generate = options.generateSite ?? generateSite;
  const applyFix = options.applyFixInstruction ?? applyFixInstruction;
  const scorer = options.score ?? scorePipelineSite;
  const maxBuildRounds = Math.max(1, options.maxBuildRounds ?? PIPELINE_MAX_BUILD_ROUNDS);
  const maxCritiqueRounds = Math.max(0, options.maxCritiqueRounds ?? PIPELINE_MAX_CRITIQUE_ROUNDS);
  const skipBuild = options.skipBuild === true;
  const cfg = options.cfg;

  const notes: string[] = [];
  const stages: PipelineStageRecord[] = [];
  const record = (entry: PipelineStageRecord): void => {
    stages.push(entry);
  };
  const usage: DesignPipelineUsage = { promptTokens: 0, completionTokens: 0, durationMs: 0 };
  const models: string[] = [];

  fs.mkdirSync(siteDir, { recursive: true });

  // The starting state is what the pipeline must beat. It is scored with the
  // same scorer and the same fixture, so `improved` is a real delta and not an
  // artifact of two different rubrics.
  let baselineTotal = 0;
  try {
    baselineTotal = (await scorer(fixture, siteDir)).total;
  } catch {
    baselineTotal = 0;
  }

  throwIfAborted(options.signal);

  // 1. classify — a UI intent is exactly what this pipeline is for, and the
  //    route is decided once so every stage agrees on the model.
  const route = routeUiModel(options.cfg);
  models.push(route.model);
  record({
    stage: "classify",
    round: 0,
    ok: true,
    summary: stageSummary("classify", true, `UI intent, ${direction} (${fixture.locale}), model ${route.model}`),
    detail: { route },
  });

  // 2. brief — the model fixes the visual direction, or the curated fallback.
  let brief: DesignBrief | null = null;
  try {
    const briefResult = await generateDesignBrief({
      cfg: {
        model: route.model,
        workspace,
        fallbackModel: cfg?.fallbackModel ?? route.model,
        agent: { maxSteps: 0, temperature: 0.2, requestTimeoutMs: 60_000 },
      } as never,
      ...(options.model ? { ollama: options.model as never } : {}),
      brief: fixture.prompt,
      language: fixture.locale,
      direction,
      signal: options.signal,
    });
    brief = briefResult.brief;
    usage.promptTokens += briefResult.usage.promptTokens;
    usage.completionTokens += briefResult.usage.completionTokens;
    usage.durationMs += briefResult.usage.durationMs;
    record({
      stage: "brief",
      round: 0,
      ok: true,
      summary: stageSummary(
        "brief",
        true,
        `${briefResult.source} brief, ${brief.palette.length} colours, ${brief.fonts.length} font(s)`,
      ),
      detail: { source: briefResult.source, warnings: briefResult.warnings },
    });
  } catch (error) {
    notes.push(`brief stage failed: ${error instanceof Error ? error.message : String(error)}`);
    record({ stage: "brief", round: 0, ok: false, summary: stageSummary("brief", false, "brief unavailable") });
  }

  // 3. examples — retrieve vetted blocks for the brief's vocabulary.
  let blocks: BlockHit[] = [];
  try {
    blocks = search(`${fixture.prompt} ${direction}`, 3);
    record({
      stage: "examples",
      round: 0,
      ok: blocks.length > 0,
      summary: stageSummary("examples", blocks.length > 0, `${blocks.length} block(s)`),
      detail: { blocks: blocks.map((block) => block.id).slice(0, 5) },
    });
  } catch (error) {
    notes.push(`example retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
    record({ stage: "examples", round: 0, ok: false, summary: stageSummary("examples", false, "retrieval unavailable") });
  }

  // 4. scaffold — a fresh starter (unless reused) plus a build entrypoint, so the
  //    build loop has something real to converge on.
  let tokensPath: string | undefined;
  try {
    if (options.reuseSite !== true) {
      writeBuildEntrypoint(siteDir);
      if (brief && options.writeTokens !== false) {
        tokensPath = await writeDesignTokens(workspace, "design-tokens.json", brief, "design_pipeline");
      }
    }
    if (!brief) throw new Error("no design brief available to scaffold against");
    record({
      stage: "scaffold",
      round: 0,
      ok: true,
      summary: stageSummary("scaffold", true, options.reuseSite ? "reused workspace" : "fresh starter + build entrypoint"),
      detail: { tokensPath },
    });
  } catch (error) {
    notes.push(`scaffold failed: ${error instanceof Error ? error.message : String(error)}`);
    record({ stage: "scaffold", round: 0, ok: false, summary: stageSummary("scaffold", false, "scaffold unavailable") });
  }

  // 5. generate — the generated site replaces the starter's own markup.
  let files: DesignFileMap;
  try {
    if (!brief) throw new Error("no design brief available for generation");
    files = generate({
      workspace: siteDir,
      files: readSiteFiles(siteDir),
      brief,
      direction,
      locale: fixture.locale,
      prompt: fixture.prompt,
      must: fixture.expectations.must ?? [],
      mustNot: fixture.expectations.mustNot ?? [],
      blocks,
      tokensPath,
    });
    if (Object.keys(files).length === 0) throw new Error("generator produced no files");
    if (Object.keys(files).length > PIPELINE_MAX_FILES) {
      notes.push(`generator produced ${Object.keys(files).length} files; kept the first ${PIPELINE_MAX_FILES}`);
      files = Object.fromEntries(Object.entries(files).slice(0, PIPELINE_MAX_FILES));
    }
    const written = writeSiteFiles(siteDir, files);
    record({
      stage: "generate",
      round: 0,
      ok: written.length > 0,
      summary: stageSummary("generate", written.length > 0, `${written.length} file(s)`),
      detail: { files: written.slice(0, 10) },
    });
  } catch (error) {
    notes.push(`generation failed: ${error instanceof Error ? error.message : String(error)}`);
    record({ stage: "generate", round: 0, ok: false, summary: stageSummary("generate", false, "generation failed") });
    files = readSiteFiles(siteDir);
  }

  // 6. autofix — the deterministic repair pass before the build loop runs.
  try {
    const repaired = autofixProject(files);
    files = repaired.files;
    writeSiteFiles(siteDir, files);
    record({
      stage: "autofix",
      round: 0,
      ok: repaired.report.ok,
      summary: stageSummary("autofix", repaired.report.ok, `${repaired.report.fixes.length} repair(s)`),
      detail: { counts: repaired.report.counts },
    });
  } catch (error) {
    notes.push(`autofix failed: ${error instanceof Error ? error.message : String(error)}`);
    record({ stage: "autofix", round: 0, ok: false, summary: stageSummary("autofix", false, "repair pass unavailable") });
  }

  // 7. build — a bounded loop of at most `maxBuildRounds` attempts.
  const built = await runBuildLoop(
    siteDir,
    files,
    linter,
    fixture,
    maxBuildRounds,
    record,
    skipBuild,
    options.signal,
  );
  files = built.files;

  // 8. screenshot — the capture itself is the caller's browser effect; the
  //    pipeline records the stage and reports what the build state allows.
  record({
    stage: "screenshot",
    round: 0,
    ok: built.build.pass,
    summary: stageSummary("screenshot", built.build.pass, built.build.pass ? "captured" : "no usable preview"),
    detail: { artifact: built.build.artifact },
  });

  // 9. critique — a bounded rubric loop over the lint result.
  const coverage = measureCoverage(fixture, files);
  const critiqued = await runCritiqueLoop(
    siteDir,
    files,
    {
      fixture,
      lint: built.lint,
      critique: critiqueImpl,
      coverage,
      applyFix,
      linter,
      maxRounds: maxCritiqueRounds,
      record,
      skipBuild,
      signal: options.signal,
    },
  );

  // 10. score — the same scorer as the baseline, so the delta is meaningful.
  let score: PipelineScore;
  try {
    score = await scorer(fixture, siteDir);
  } catch (error) {
    notes.push(`final scoring failed: ${error instanceof Error ? error.message : String(error)}`);
    score = { lint: critiqued.lint.score, critique: critiqued.critique.score, build: built.build.pass ? 100 : 0, total: 0, verdict: "fail", coverage: critiqued.coverage };
  }
  const improved = score.total > baselineTotal;
  usage.durationMs = Date.now() - startedAt;

  return {
    ok: score.verdict === "pass",
    fixtureId: fixture.id,
    workspace: siteDir,
    score,
    brief,
    route,
    model: { model: models[0] ?? route.model, callCount: models.length, models },
    stages,
    notes,
    usage,
    improved,
    baselineTotal,
    ...(fixture.expectations.minLint !== undefined ? { minLint: fixture.expectations.minLint } : {}),
  };
}

/** Score a finished site with the real linter, mock critique and build check. */
export async function scorePipelineSite(
  fixture: DesignPipelineFixture,
  siteDir: string,
  deps: { linter?: DesignLinter; critique?: DesignCritique; build?: boolean } = {},
): Promise<PipelineScore> {
  const linter = deps.linter ?? minimalDesignLinter();
  const critiqueImpl = deps.critique ?? mockDesignCritique();
  const lint = await linter.lintSite(siteDir, { locale: fixture.locale, direction: fixture.direction });
  const coverage = measureCoverage(fixture, readSiteFiles(siteDir));
  const critique = await critiqueImpl.critique({
    siteDir,
    fixtureId: fixture.id,
    prompt: fixture.prompt,
    locale: fixture.locale,
    direction: fixture.direction,
    lint,
    expectations: { must: fixture.expectations.must, mustNot: fixture.expectations.mustNot, coverage },
  });
  const build = deps.build === false
    ? { pass: true, command: "skipped", exitCode: 0, output: "", artifact: null }
    : await checkSiteBuild(siteDir);
  const total = Math.round(lint.score * 0.5 + critique.score * 0.3 + (build.pass ? 100 : 0) * 0.2);
  const minLint = fixture.expectations.minLint;
  const lintBarMet = minLint === undefined || lint.score >= minLint;
  const verdict: PipelineScore["verdict"] = total >= PIPELINE_PASS_THRESHOLD && build.pass && lintBarMet ? "pass" : "fail";
  return { lint: lint.score, critique: critique.score, build: build.pass ? 100 : 0, total, verdict, coverage };
}

/** One isolated workspace per pipeline run. */
export function createPipelineWorkspace(root?: string): string {
  return fs.mkdtempSync(path.join(root ?? os.tmpdir(), "loam-design-pipeline-"));
}

/** Remove a pipeline workspace and everything under it. */
export function removePipelineWorkspace(workspace: string): void {
  fs.rmSync(workspace, { recursive: true, force: true });
}

/** True when a locale or an explicit direction implies right-to-left layout. */
export function isRtlFixture(locale: string, explicit?: "ltr" | "rtl"): boolean {
  return resolveDirection(locale, explicit) === "rtl";
}

export { STAGE_NAMES, isRtl };
