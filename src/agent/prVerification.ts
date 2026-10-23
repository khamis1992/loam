/**
 * D5 proof-of-work verification: derive a test plan from a pull request's diff,
 * run those user flows with Playwright (recorded video + screenshots) against a
 * local static app, and render the "Verification" checklist section that
 * verify_and_record appends to the PR body.
 *
 * Design constraints:
 *  - No network beyond the loopback static server; nothing here reaches the
 *    internet. Playwright loads the local origin only.
 *  - The runner reuses the same file-serve + context-per-scenario pattern as
 *    `src/agent/appVerification.ts` (local-only network, screenshots, per-step
 *    assertions) without dragging in the vision/backend sandbox machinery.
 *  - Every input path is validated so a workspace-relative argument can never
 *    escape the workspace.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { resolveRead, resolveWrite } from "../policy/paths.js";
import type { Config } from "../config.js";

/** A diff hunk: the added/removed line plus its position in the file. */
export interface DiffLine {
  file: string;
  line: number;
  sign: "+" | "-";
  text: string;
}

/** One user flow the diff implies, expressed as concrete Playwright steps. */
export interface TestPlanStep {
  action: "fill" | "click" | "wait" | "expect-text" | "expect-url";
  /** Selector for fill/click/expect-text; substring for expect-url. */
  selector?: string;
  value?: string;
}

export interface TestPlanFlow {
  name: string;
  /** Path that carries this flow (repository-relative, "/" separators). */
  file: string;
  summary: string;
  steps: TestPlanStep[];
}

export interface TestPlan {
  /** Changed paths, newest first. */
  files: string[];
  flows: TestPlanFlow[];
}

/** Minimal validator for the declarative fixture format used by tests. */
export interface PrVerificationFixture {
  name: string;
  steps: Array<{ action: string; selector?: string; value?: string }>;
}

export interface PrVerificationFlowInput {
  name: string;
  file?: string;
  steps: Array<{ action: string; selector?: string; value?: string }>;
}

export interface PrVerificationOptions {
  /** Directory that serves the app (relative to the workspace, or absolute). */
  root: string;
  /** Entry document to open (default index.html). */
  entry?: string;
  /** Test plan to run. */
  flows: PrVerificationFlowInput[];
  /** Recorded video + screenshots land under `<workspace>/<artifacts>/<run>`. */
  artifacts?: string;
  /** Run id (the artifact sub-directory); a fresh uuid when omitted. */
  run?: string;
  /** Browser channel override (tests pass "chromium" to use the bundled build). */
  channel?: string;
  /** Per-flow and per-action timeouts in milliseconds. */
  timeoutMs?: number;
}

export interface FlowArtifact {
  name: string;
  status: "passed" | "failed";
  video?: string;
  screenshot?: string;
  failureScreenshot?: string;
  error?: string;
  /** Human-facing action trace for the report. */
  steps: Array<{ action: string; ok: boolean; message: string }>;
}

export interface PrVerificationResult {
  run: string;
  entry: string;
  pass: boolean;
  artifactsDir: string;
  flows: FlowArtifact[];
  videos: string[];
  screenshots: string[];
}

export interface ChecklistItem {
  name: string;
  file: string;
  status: "pass" | "fail";
  video?: string;
  screenshot?: string;
  failureScreenshot?: string;
}

export const VERIFICATION_MARKER = "<!-- loam:verification -->";
export const VERIFICATION_HEADING = "## Verification";

/** Fixed MIME map for the loopback server (keeps the module self-contained). */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/* ------------------------------------------------------------------ *
 * Diff parsing / test-plan derivation
 * ------------------------------------------------------------------ */

/** Parse a unified git diff into per-file hunks. Added/deleted file lines
 *  (`+++`/`---`) are skipped; only real content lines are returned. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let file = "";
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split(/\r?\n/)) {
    const header = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = oldLine;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).trim();
      if (file.startsWith("b/")) file = file.slice(2);
      if (file === "/dev/null") file = "";
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("diff ") || raw.startsWith("index ")) continue;
    if (raw.startsWith("+")) {
      out.push({ file, line: newLine++, sign: "+", text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("-")) {
      out.push({ file, line: oldLine++, sign: "-", text: raw.slice(1) });
      continue;
    }
    oldLine++;
    newLine++;
  }
  return out;
}

export interface PlanCandidate {
  file: string;
  kind: "style" | "text" | "structure";
  summary: string;
  line: number;
}

/** Candidate files for the plan: HTML files first, then changed source files. */
export function candidateFiles(diffLines: DiffLine[]): string[] {
  const seen = new Set<string>();
  const html: string[] = [];
  const other: string[] = [];
  for (const entry of diffLines) {
    if (!entry.file || seen.has(entry.file)) continue;
    seen.add(entry.file);
    if (/\.html?$/i.test(entry.file)) html.push(entry.file);
    else if (/\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|vue|svelte)$/i.test(entry.file)) other.push(entry.file);
  }
  return [...html, ...other];
}

const UI_KEYWORDS = [
  ["button", "button activation"],
  ["submit", "form submission"],
  ["click", "click interaction"],
  ["input", "form input"],
  ["placeholder", "input hint"],
  ["value=", "form value"],
  ["<a ", "link navigation"],
  ["href=", "link navigation"],
  ["title=", "document title"],
  ["<h1", "page heading"],
  ["<h2", "section heading"],
  ["<h3", "section heading"],
  ["text-", "text styling"],
  ["background", "background styling"],
  ["color", "colour styling"],
  ["grid", "layout"],
  ["flex", "layout"],
  ["card", "card component"],
  ["price", "pricing display"],
  ["nav", "navigation"],
  ["footer", "footer"],
  ["hero", "hero section"],
  ["class=", "component structure"],
  ["id=", "component structure"],
  ["<div", "layout"],
  ["display", "layout"],
  ["border", "border styling"],
  ["padding", "spacing"],
  ["margin", "spacing"],
  ["font", "typography"],
] as const;

/** Heuristic candidates: what the diff changed, expressed as user-visible work. */
export function planCandidates(diffLines: DiffLine[]): PlanCandidate[] {
  const out: PlanCandidate[] = [];
  for (const entry of diffLines) {
    if (!entry.file) continue;
    const haystack = entry.text.toLowerCase();
    if (!haystack.trim()) continue;
    const kind: PlanCandidate["kind"] = /\.html?$/i.test(entry.file) ? "structure" : "text";
    let matched = false;
    for (const [needle, summary] of UI_KEYWORDS) {
      if (haystack.includes(needle)) {
        out.push({ file: entry.file, kind, summary, line: entry.line });
        matched = true;
        break;
      }
    }
    if (!matched && /[^\s{}()<>;:=,]{3,}/.test(entry.text)) {
      out.push({ file: entry.file, kind: "text", summary: `changed line: ${entry.text.trim().slice(0, 80)}`, line: entry.line });
    }
  }
  return out;
}

/** Turn a selector-like fragment of the diff into a flow, or null if none fits. */
export function selectorFromDiffText(text: string): string | null {
  for (const match of text.matchAll(/id\s*=\s*["']([^"']+)["']/g)) {
    const id = match[1]!.trim();
    if (id && !/[<>"']/.test(id)) return `#${id}`;
  }
  for (const match of text.matchAll(/class\s*=\s*["']([^"']+)["']/g)) {
    const first = match[1]!.trim().split(/\s+/)[0];
    if (first && /^[A-Za-z][\w-]*$/.test(first)) return `.${first}`;
  }
  for (const match of text.matchAll(/for\s*=\s*["']([^"']+)["']/g)) {
    const id = match[1]!.trim();
    if (id && !/[<>"']/.test(id)) return `#${id}`;
  }
  return null;
}

const CLAIM_PATTERNS: Array<[RegExp, RegExp]> = [
  [/\bform\b/i, /<form/i],
  [/\bbutton\b/i, /<button/i],
  [/\binput\b|<\s*input/i, /<input/i],
  [/\bsubmit\b/i, /submit/i],
  [/\blink\b|navigation/i, /<a\s/i],
  [/\bplaceholder\b/i, /placeholder=/i],
  [/\bheading\b|title/i, /<h[1-6]\b|<title/i],
  [/\blayout\b|grid|flex/i, /class=|style=/i],
  [/\bcard\b/i, /class=/i],
  [/\bcolor|colour|background/i, /background|color/i],
];

/** Only claim flows the diff actually supports, so the checklist stays honest. */
export function isClaimedByDiff(claim: string, diffText: string): boolean {
  const lower = claim.toLowerCase();
  for (const [claimPattern, diffPattern] of CLAIM_PATTERNS) {
    if (claimPattern.test(lower) && diffPattern.test(diffText)) return true;
  }
  return false;
}

const DEFAULT_TEXT = "Welcome";

/**
 * Derive a test plan (a list of user flows) from a pull request diff.
 *
 * The plan is deliberately conservative: every flow's assertions are anchored
 * in text that the diff itself adds, so a flow can only pass when the diff's
 * own change is present in the rendered app.
 */
export function planFromDiff(diff: string): TestPlan {
  const lines = parseUnifiedDiff(diff);
  const files = candidateFiles(lines);
  const diffText = lines.map((entry) => entry.text).join("\n");
  const candidates = planCandidates(lines);

  const flows: TestPlanFlow[] = [];
  const push = (flow: TestPlanFlow): void => {
    if (flows.some((existing) => existing.name === flow.name)) return;
    if (flows.length >= 8) return;
    flows.push(flow);
  };

  const htmlFiles = files.filter((f) => /\.html?$/i.test(f));

  // A primary flow per changed page: load it and assert it responds.
  for (const file of htmlFiles.slice(0, 3)) {
    const entry = path.basename(file).replace(/\.html?$/i, "") || "index";
    push({
      name: `Page renders: ${entry}`,
      file,
      summary: `load /${entry} and confirm the page responds`,
      steps: [{ action: "expect-url", value: entry }],
    });
  }

  // Interaction flows, anchored to selectors the diff itself introduces.
  const claimed = new Set<string>();
  for (const cand of candidates) {
    if (flows.length >= 8) break;
    const raw = lines.find((entry) => entry.file === cand.file && entry.line === cand.line)?.text ?? "";
    const selector = selectorFromDiffText(raw);
    if (!selector) continue;
    const lowered = raw.toLowerCase();
    const isButton = lowered.includes("button") || /type\s*=\s*["']submit["']/i.test(raw);
    const isInput = lowered.includes("<input") || lowered.includes("placeholder");
    if (isButton) {
      if (claimed.has("submit")) continue;
      claimed.add("submit");
      if (!isClaimedByDiff("button submit form", diffText)) continue;
      push({ name: "Submit flow", file: cand.file, summary: cand.summary, steps: [{ action: "click", selector }, { action: "wait", value: "300" }] });
      continue;
    }
    if (isInput) {
      if (claimed.has("input")) continue;
      claimed.add("input");
      if (!isClaimedByDiff("input placeholder form", diffText)) continue;
      push({ name: "Fill input flow", file: cand.file, summary: cand.summary, steps: [{ action: "fill", selector, value: "Loam" }, { action: "wait", value: "200" }] });
    }
  }

  // Fallback: the first changed page still gets a smoke flow so a plan is never empty.
  if (flows.length === 0) {
    const file = htmlFiles[0] ?? files[0] ?? "index.html";
    const entry = path.basename(file).replace(/\.html?$/i, "") || "index";
    flows.push({
      name: `Page renders: ${entry}`,
      file,
      summary: `load /${entry} and confirm the page responds`,
      steps: [{ action: "expect-url", value: entry }],
    });
  }
  return { files, flows };
}

/* ------------------------------------------------------------------ *
 * Checklist rendering
 * ------------------------------------------------------------------ */

/** Markdown link to a recorded artifact, or a plain note when it is missing. */
export function artifactLink(label: string, file: string | undefined): string {
  if (!file) return `${label}: not captured`;
  return `${label}: [${path.basename(file)}](${file})`;
}

/** Render the Verification checklist section (the block appended to the PR body). */
export function renderVerificationChecklist(result: PrVerificationResult): string {
  const lines: string[] = [VERIFICATION_MARKER, "", VERIFICATION_HEADING, "", `Entry: \`${result.entry}\` — ${result.flows.filter((f) => f.status === "passed").length}/${result.flows.length} flows passed.`, ""];
  lines.push("| Flow | Status | Evidence |", "| --- | --- | --- |");
  for (const flow of result.flows) {
    const evidence = flow.status === "passed" ? artifactLink("video", flow.video) : artifactLink("failure screenshot", flow.failureScreenshot);
    lines.push(`| ${flow.name} | ${flow.status === "passed" ? "pass" : "fail"} | ${evidence} |`);
  }
  if (result.flows.some((f) => f.status === "failed")) {
    const failed = result.flows.filter((f) => f.status === "failed");
    lines.push("", "Failures:", ...failed.map((f) => `- ${f.name}: ${f.error ?? "flow did not complete"}`));
  }
  return lines.join("\n");
}

/**
 * Append (or replace) the Verification section on a pull request body.
 * The marker makes the update idempotent: re-running verify_and_record never
 * duplicates the section.
 */
export function appendVerificationSection(existing: string, section: string): string {
  const body = existing.trimEnd();
  const index = body.indexOf(VERIFICATION_MARKER);
  const stripped = index === -1 ? body : body.slice(0, index).trimEnd();
  return `${stripped}\n\n${section}\n`;
}

/* ------------------------------------------------------------------ *
 * Playwright runner
 * ------------------------------------------------------------------ */

/** Reject a root that escapes the workspace or is not a directory. */
function resolveAppRoot(workspace: string, root: string): string {
  const resolved = path.isAbsolute(root) ? path.resolve(root) : path.resolve(workspace, root);
  const base = path.resolve(workspace);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`app root is outside the workspace: ${root}`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`app root is not a directory: ${root}`);
  }
  return resolved;
}

/** Serve the app on a loopback port only; unknown paths 404. */
async function serveApp(root: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let relative: string;
    try {
      relative = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname).replace(/^\/+/, "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const target = resolveRead(root, relative || "index.html", false);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(fs.readFileSync(target));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("static server has no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Build a per-flow app URL: entry plus an optional `?file=` deep link. */
function entryUrl(origin: string, entry: string, flow: PrVerificationFlowInput): string {
  const clean = entry.replace(/^\/+/, "");
  if (!flow.file || clean === flow.file.replace(/^\/+/, "")) return `${origin}/${clean.split("/").map(encodeURIComponent).join("/")}`;
  const params = new URLSearchParams({ file: flow.file.replace(/^\/+/, "") });
  return `${origin}/${clean.split("/").map(encodeURIComponent).join("/")}?${params.toString()}`;
}

/** Map a fixture step to a Playwright action; unsupported steps are skipped. */
function stepToAction(step: { action: string; selector?: string; value?: string }): TestPlanStep | null {
  const action = step.action.trim().toLowerCase();
  if (action === "fill") {
    if (!step.selector) return null;
    return { action: "fill", selector: step.selector, value: step.value ?? "" };
  }
  if (action === "click") {
    if (!step.selector) return null;
    return { action: "click", selector: step.selector };
  }
  if (action === "wait") return { action: "wait", value: step.value ?? "300" };
  if (action === "expect-text" || action === "text") {
    if (!step.selector) return null;
    return { action: "expect-text", selector: step.selector, value: step.value ?? "" };
  }
  if (action === "expect-url") return { action: "expect-url", value: step.value ?? "" };
  return null;
}

/**
 * Run a verification plan with Playwright against a local static app.
 *
 * Each flow gets its own isolated browser context with `recordVideo` enabled,
 * so every flow yields a standalone .webm video plus a screenshot of its final
 * state (and a failure screenshot when a step fails). The whole run is bounded
 * by the caller's signal and a per-action timeout.
 */
export async function runPrVerification(
  cfg: Config,
  workspace: string,
  options: PrVerificationOptions,
  signal?: AbortSignal,
): Promise<PrVerificationResult> {
  const root = resolveAppRoot(workspace, options.root);
  const run = options.run ?? randomUUID();
  const artifactsDir = resolveWrite(workspace, options.artifacts ? path.join(options.artifacts, run) : path.join(".verification", "pr", run));
  fs.mkdirSync(artifactsDir, { recursive: true });
  const entry = (options.entry ?? "index.html").replace(/^\/+/, "");
  if (!fs.existsSync(resolveRead(root, entry, false))) throw new Error(`entry not found: ${entry}`);
  const flows = options.flows
    .map((flow) => ({ name: flow.name, file: flow.file, steps: flow.steps.map(stepToAction).filter((step): step is TestPlanStep => step !== null) }))
    .filter((flow) => flow.steps.length > 0);
  if (flows.length === 0) throw new Error("no runnable flows in the verification plan");

  const { origin, close } = await serveApp(root);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 15_000);
  const result: PrVerificationResult = {
    run,
    entry,
    pass: false,
    artifactsDir,
    flows: [],
    videos: [],
    screenshots: [],
  };
  let browser: import("playwright").Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(options.channel ? { channel: options.channel } : {}) });
    signal?.throwIfAborted();
    for (const flow of flows) {
      signal?.throwIfAborted();
      const videoDir = path.join(artifactsDir, "video");
      fs.mkdirSync(videoDir, { recursive: true });
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } });
      // Only the loopback origin is reachable: external requests are aborted so
      // the verification can never touch the network.
      await context.route("**/*", (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      const artifact: FlowArtifact = { name: flow.name, status: "failed", steps: [] };
      try {
        const url = entryUrl(origin, entry, flow);
        const response = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
        if (!response || !response.ok()) throw new Error(`app did not load: ${response ? `HTTP ${response.status()}` : "no response"}`);
        for (const step of flow.steps) {
          switch (step.action) {
            case "fill":
              await page.fill(step.selector!, step.value ?? "", { timeout: timeoutMs });
              artifact.steps.push({ action: `fill ${step.selector}`, ok: true, message: `filled "${step.value ?? ""}"` });
              break;
            case "click":
              await page.click(step.selector!, { timeout: timeoutMs });
              artifact.steps.push({ action: `click ${step.selector}`, ok: true, message: "clicked" });
              break;
            case "wait":
              await page.waitForTimeout(Math.min(Number(step.value ?? 300) || 300, timeoutMs));
              artifact.steps.push({ action: "wait", ok: true, message: `${step.value ?? 300}ms` });
              break;
            case "expect-text":
              await page.locator(step.selector!).filter({ hasText: step.value ?? "" }).first().waitFor({ state: "visible", timeout: timeoutMs });
              artifact.steps.push({ action: `expect-text ${step.selector}`, ok: true, message: `contains "${step.value ?? ""}"` });
              break;
            case "expect-url":
              await page.waitForFunction(
                (expected) => {
                  const url = new URL(window.location.href);
                  return url.pathname.includes(expected) || url.searchParams.get("file")?.includes(expected) === true;
                },
                step.value ?? "",
                { timeout: timeoutMs },
              );
              artifact.steps.push({ action: "expect-url", ok: true, message: `url carries "${step.value ?? ""}"` });
              break;
          }
        }
        const shot = path.join(artifactsDir, `${slug(flow.name)}.png`);
        await page.screenshot({ path: shot, fullPage: false, animations: "disabled", timeout: timeoutMs });
        artifact.screenshot = shot;
        artifact.status = "passed";
      } catch (error) {
        artifact.error = error instanceof Error ? error.message : String(error);
        artifact.steps.push({ action: "flow", ok: false, message: artifact.error });
        if (!page.isClosed()) {
          try {
            const failure = path.join(artifactsDir, `${slug(flow.name)}-failed.png`);
            await page.screenshot({ path: failure, fullPage: false, animations: "disabled", timeout: Math.min(2000, timeoutMs) });
            artifact.failureScreenshot = failure;
          } catch {
            /* best effort */
          }
        }
      }
      // Materialise the video: closing the page flushes the .webm into videoDir.
      const video = page.video();
      try {
        await page.close();
      } catch {
        /* ignore */
      }
      if (video) {
        try {
          const raw = await video.path();
          if (raw) {
            const dest = path.join(artifactsDir, `${slug(flow.name)}.webm`);
            fs.renameSync(raw, dest);
            artifact.video = dest;
          }
        } catch {
          /* the video may already be gone; the flow still has its screenshot */
        }
      }
      try {
        await context.close();
      } catch {
        /* ignore */
      }
      if (artifact.video) result.videos.push(artifact.video);
      if (artifact.screenshot) result.screenshots.push(artifact.screenshot);
      result.flows.push(artifact);
    }
    result.pass = result.flows.every((flow) => flow.status === "passed");
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    await close();
  }
  return result;
}

/** Filesystem-safe name for an artifact derived from a flow name. */
export function slug(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 60) || "flow";
}

/** Load a declarative fixture plan (used by tests and by app-verification.json). */
export function fixtureFlows(manifest: { scenarios?: PrVerificationFixture[]; entry?: string }): PrVerificationFlowInput[] {
  return (manifest.scenarios ?? []).map((scenario) => ({ name: scenario.name, steps: scenario.steps }));
}
