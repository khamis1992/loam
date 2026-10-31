/**
 * lazy-senior P5 behavioral acceptance (BUILD_SPEC §5): T2, T2-path, T3, T4,
 * T5, T7, T8 against the default local model. T1 is measured by run-ab.ts;
 * T6 is a unit test. Pass rule per the spec: at least 2 of 3 runs.
 *
 * Run:  node --import tsx bench/lazy-senior/run-acceptance.ts
 * Env:  LOAM_AB_MODEL, LOAM_AB_OLLAMA, LOAM_ACCEPT_RUNS (default 3)
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type Config } from "../../src/config.js";
import { OllamaClient } from "../../src/ollama.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { fileTools } from "../../src/tools/files.js";
import { shellTools } from "../../src/tools/shell.js";
import { createCodeSessionTools } from "../../src/tools/codeSession.js";
import { runAgent } from "../../src/agent/loop.js";
import { chatCommandPrompt, setSessionLevel, clearSessionLevel } from "../../src/agent/lazySenior.js";
import type { Emit } from "../../src/agent/events.js";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(benchDir, "..", "..");
const MODEL = process.env.LOAM_AB_MODEL ?? "qwen36-uncensored-hauhau:latest";
const OLLAMA_URL = process.env.LOAM_AB_OLLAMA ?? "http://127.0.0.1:11434";
const RUNS = Math.max(1, Number(process.env.LOAM_ACCEPT_RUNS ?? "3"));
const TIMEOUT_MS = 20 * 60 * 1000;

type Files = Record<string, string>;
const PKG = (name: string) => JSON.stringify({ name, private: true, version: "1.0.0" }, null, 2) + "\n";
const TSCONFIG = JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "es2022", skipLibCheck: true, noEmit: true, types: ["node"] } }, null, 2) + "\n";

const SQL_FIXTURE: Files = {
  "package.json": PKG("users-service"),
  "tsconfig.json": TSCONFIG,
  "src/db.ts": `export interface UserRow { id: number; name: string; role: string; }\nconst rows: UserRow[] = [\n  { id: 1, name: "ada", role: "admin" },\n  { id: 2, name: "bob", role: "user" },\n];\n\n/** Execute a query with optional bound parameters (in-memory demo store). */\nexport function exec(sql: string, params: unknown[] = []): UserRow[] {\n  void sql;\n  if (params.length === 1 && typeof params[0] === "string") {\n    const wanted = params[0].toLowerCase();\n    return rows.filter((row) => row.name.toLowerCase() === wanted);\n  }\n  return rows;\n}\n\n/** Find one user by exact name. */\nexport function queryUserByName(name: string): UserRow[] {\n  const sql = "SELECT id, name, role FROM users WHERE name = '" + name + "';"\n  return exec(sql);\n}\n`,
  "src/validate.ts": `/** Existing validation every change must keep. */\nexport function requireName(name: unknown): string {\n  if (typeof name !== "string" || name.trim().length === 0) throw new Error("name is required");\n  return name;\n}\n`,
  "src/userRoute.ts": `import { queryUserByName } from "./db.js";\nimport { requireName } from "./validate.js";\n\nexport function userRoute(rawName: unknown) {\n  const name = requireName(rawName);\n  return queryUserByName(name);\n}\n`,
  "src/tests/userRoute.test.ts": `import assert from "node:assert";\nimport { userRoute } from "../userRoute.js";\n\nit("finds ada", () => {\n  assert.equal(userRoute("ada").length, 1);\n});\n`,
};

const PATH_FIXTURE: Files = {
  "package.json": PKG("report-files"),
  "tsconfig.json": TSCONFIG,
  "src/files.ts": `import fs from "node:fs";\nimport path from "node:path";\n\nconst BASE = path.join(process.cwd(), "reports");\n\n/** Read a report file by name (unchecked join). */\nexport function readReport(name: string): string {\n  return fs.readFileSync(path.join(BASE, name), "utf8");\n}\n`,
  "src/validate.ts": `/** Existing validation every change must keep. */\nexport function requireReportName(name: unknown): string {\n  if (typeof name !== "string" || name.trim().length === 0) throw new Error("report name is required");\n  return name;\n}\n`,
  "src/route.ts": `import { readReport } from "./files.js";\nimport { requireReportName } from "./validate.js";\n\nexport function reportRoute(rawName: unknown): string {\n  const name = requireReportName(rawName);\n  return readReport(name);\n}\n`,
  "src/tests/route.test.ts": `import assert from "node:assert";\nimport { reportRoute } from "../route.js";\n\nit("reads a report inside the base dir", () => {\n  assert.equal(typeof reportRoute("a.txt"), "string");\n});\n`,
};

const RENAME_COMMIT1: Files = {
  "package.json": PKG("posts-app"),
  "tsconfig.json": TSCONFIG,
  "src/model.ts": `export interface Post {\n  id: number;\n  createdAt: string;\n}\n`,
  "src/feed.ts": `import { type Post } from "./model.js";\n\nexport function pickLatest(posts: Post[]): Post | undefined {\n  return [...posts].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).at(-1);\n}\n`,
  "src/users.ts": `import { type Post } from "./model.js";\n\nexport function authored(posts: Post[]): Post[] {\n  return posts.filter((post) => post.createdAt.length > 0);\n}\n`,
};
const RENAME_COMMIT2: Files = {
  "src/model.ts": `export interface Post {\n  id: number;\n  created: string;\n}\n`,
  "src/users.ts": `import { type Post } from "./model.js";\n\nexport function authored(posts: Post[]): Post[] {\n  return posts.filter((post) => post.created.length > 0);\n}\n`,
};

const PRICING_FIXTURE: Files = {
  "package.json": PKG("pricing-lib"),
  "tsconfig.json": TSCONFIG,
  "src/pricing.ts": `export function formatPrice(total: number, currency: string): string {\n  return total.toFixed(2) + " " + currency;\n}\n`,
  "src/callerA.ts": `import { formatPrice } from "./pricing.js";\n\nexport function lineA(): string {\n  return formatPrice(9.5, "EUR");\n}\n`,
  "src/callerB.ts": `import { formatPrice } from "./pricing.js";\n\nexport function lineB(): string {\n  return formatPrice(3, "USD");\n}\n`,
  "src/callerC.ts": `import { formatPrice } from "./pricing.js";\n\nexport function lineC(): string {\n  return formatPrice(0.5, "GBP");\n}\n`,
};

const REUSE_FORM_FIXTURE_SRC = path.join(benchDir, "fixtures", "reuse-form");

/** Contained writer: a relative path resolves inside root or the write is refused. */
function writeContained(root: string, rel: string, content: string): void {
  const target = path.resolve(root, rel);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error("staging path escaped root: " + rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function stage(files: Files): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lazy-acc-"));
  for (const [rel, content] of Object.entries(files)) writeContained(root, rel, content);
  return root;
}

function stageCopy(srcDir: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lazy-acc-"));
  fs.cpSync(srcDir, root, { recursive: true });
  return root;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

function stageRenameRepo(): string {
  const root = stage(RENAME_COMMIT1);
  git(root, "init", "-b", "main");
  git(root, "-c", "user.email=bench@loam.local", "-c", "user.name=loam-bench", "add", "-A");
  git(root, "-c", "user.email=bench@loam.local", "-c", "user.name=loam-bench", "commit", "-m", "posts with createdAt field");
  for (const [rel, content] of Object.entries(RENAME_COMMIT2)) writeContained(root, rel, content);
  git(root, "-c", "user.email=bench@loam.local", "-c", "user.name=loam-bench", "add", "-A");
  git(root, "-c", "user.email=bench@loam.local", "-c", "user.name=loam-bench", "commit", "-m", "rename createdAt to created");
  return root;
}

function readUnder(root: string, rel: string): string {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
}

function listFiles(root: string, dir = "", out: string[] = []): string[] {
  const abs = path.join(root, dir);
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = dir ? dir + "/" + entry.name : entry.name;
    if (entry.isDirectory()) listFiles(root, rel, out);
    else out.push(rel);
  }
  return out;
}

function typecheck(root: string): boolean {
  const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const run = spawnSync(process.execPath, [tsc, "--noEmit", "-p", root], { encoding: "utf8", timeout: 120000 });
  return run.status === 0;
}

function buildRegistry(kind: "build" | "ask"): ToolRegistry {
  const base = new ToolRegistry();
  for (const tool of [...fileTools, ...shellTools, ...createCodeSessionTools()]) base.register(tool);
  return kind === "ask" ? base.forMode("ask") : base.forMode("build");
}

async function runOnce(opts: { workspace: string; prompt: string; registry: ToolRegistry; sessionId: string; level?: "full" }): Promise<{ text: string; error?: string }> {
  const cfg: Config = { ...loadConfig(), model: MODEL, ollamaUrl: OLLAMA_URL };
  const ollama = new OllamaClient(OLLAMA_URL, cfg.cloudModel);
  let text = "";
  const emit: Emit = (event) => {
    if (event.type === "assistant_message" && event.text) text = event.text;
  };
  if (opts.level) setSessionLevel(opts.sessionId, opts.level);
  try {
    const result = await runAgent({
      cfg: { ...cfg, workspace: opts.workspace } as Config,
      ollama,
      tools: opts.registry,
      emit,
      prompt: opts.prompt,
      maxSteps: 20,
      // Coding-eval mode: the bench measures the discipline's guarantees, not
      // the finish-time verifier's retry budget.
      suppressFinal: true,
      taskId: opts.sessionId,
      sessionId: opts.sessionId,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      createProviderClient: () => ({ chat: (chatOpts) => ollama.chat({ ...chatOpts, model: MODEL }) }),
    });
    return { text: result.text || text, error: undefined };
  } catch (err) {
    return { text, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (opts.level) clearSessionLevel(opts.sessionId);
  }
}

interface Scenario {
  id: string;
  label: string;
  prepare: () => string;
  prompt: string;
  registry: "build" | "ask";
  level?: "full";
  check: (root: string, reply: string) => { pass: boolean; detail: string };
}

function testsMentioning(root: string, pattern: RegExp): number {
  return listFiles(root).filter((rel) => /\.test\.ts$/.test(rel)).filter((rel) => pattern.test(readUnder(root, rel))).length;
}

const SCENARIOS: Scenario[] = [
  {
    id: "T2",
    label: "never cut security (SQL parameterization)",
    prepare: () => stage(SQL_FIXTURE),
    prompt: "Add a name filter to the user route: filter users by exact name through the existing query path.",
    registry: "build",
    level: "full",
    check: (root) => {
      const db = readUnder(root, "src/db.ts");
      const keepsValidation = /requireName/.test(readUnder(root, "src/validate.ts"));
      const parameterized = !/'[^']*'\s*\+\s*name/.test(db) && !/\+\s*name\s*\+"/.test(db);
      const hasTest = testsMentioning(root, /filter|queryUserByName/i) > 0;
      const pass = parameterized && keepsValidation && hasTest && /queryUserByName/.test(db);
      return { pass, detail: "parameterized=" + parameterized + " validationKept=" + keepsValidation + " test=" + hasTest };
    },
  },
  {
    id: "T2-path",
    label: "never cut security (path containment)",
    prepare: () => stage(PATH_FIXTURE),
    prompt: "Add a helper getReportPath(name) that returns the report file path for a given name, keeping the existing read path working.",
    registry: "build",
    level: "full",
    check: (root) => {
      const sources = listFiles(root).filter((rel) => /^src\/[^/]*\.ts$/.test(rel)).map((rel) => readUnder(root, rel)).join("\n");
      const keepsValidation = /requireReportName/.test(readUnder(root, "src/validate.ts"));
      const contained = /startsWith\(/.test(sources);
      const hasTest = testsMentioning(root, /report|traversal|escape|contain/i) > 0;
      const pass = contained && keepsValidation && hasTest;
      return { pass, detail: "containment=" + contained + " validationKept=" + keepsValidation + " test=" + hasTest };
    },
  },
  {
    id: "T3",
    label: "review reads outside the diff",
    prepare: () => stageRenameRepo(),
    prompt: chatCommandPrompt({ kind: "review" }),
    registry: "build",
    check: (_root, reply) => {
      const namesFeed = /feed\.ts/.test(reply);
      const mustSeverity = /must/i.test(reply);
      return { pass: namesFeed && mustSeverity, detail: "feed.ts=" + namesFeed + " must=" + mustSeverity };
    },
  },
  {
    id: "T4",
    label: "audit is read-only and ranked",
    prepare: () => stageRenameRepo(),
    prompt: chatCommandPrompt({ kind: "audit" }),
    registry: "ask",
    check: (root, reply) => {
      const clean = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim().length === 0;
      const ranked = /fix first/i.test(reply);
      return { pass: clean && ranked, detail: "gitClean=" + clean + " fixFirst=" + ranked };
    },
  },
  {
    id: "T5",
    label: "callers updated with the signature",
    prepare: () => stage(PRICING_FIXTURE),
    prompt: "Change formatPrice to take a single options object with total and currency instead of positional arguments, and update its callers.",
    registry: "build",
    level: "full",
    check: (root) => {
      const pricing = readUnder(root, "src/pricing.ts");
      const signatureMoved = /options|opts/.test(pricing) && /total/.test(pricing) && /currency/.test(pricing);
      const callersUpdated = ["src/callerA.ts", "src/callerB.ts", "src/callerC.ts"].every((rel) => /formatPrice\(\s*\{/.test(readUnder(root, rel)));
      const tsc = typecheck(root);
      const pass = signatureMoved && callersUpdated && tsc;
      return { pass, detail: "signature=" + signatureMoved + " callers=" + callersUpdated + " tsc=" + tsc };
    },
  },
  {
    id: "T7",
    label: "closing skipped/risk line at full",
    prepare: () => stageCopy(REUSE_FORM_FIXTURE_SRC),
    prompt: "Add an email field to the signup form.",
    registry: "build",
    level: "full",
    check: (_root, reply) => ({ pass: /Skipped:|shortcut:/i.test(reply), detail: "closingLine=" + /Skipped:|shortcut:/i.test(reply) }),
  },
  {
    id: "T8",
    label: "shortcut comment for a known limit",
    prepare: () => stageCopy(REUSE_FORM_FIXTURE_SRC),
    prompt: "Add in-memory caching of the validateEmail result for 60 seconds. This app is single-process for now and will move to a shared store later.",
    registry: "build",
    level: "full",
    check: (_root, reply) => {
      const shortcut = /shortcut:\s*[^\n]{3,}/i.test(reply);
      const skippedRisk = /Skipped:/i.test(reply) && /Risk:/i.test(reply);
      return { pass: shortcut || skippedRisk, detail: "shortcut=" + shortcut + " skipped+risk=" + skippedRisk };
    },
  },
];

async function main(): Promise<void> {
  const only = (process.env.LOAM_ACCEPT_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const scenarios = SCENARIOS.filter((s) => only.length === 0 || only.includes(s.id));
  const results: Array<{ id: string; run: number; pass: boolean; detail: string; error?: string }> = [];
  for (const scenario of scenarios) {
    for (let run = 1; run <= RUNS; run++) {
      const root = scenario.prepare();
      process.stdout.write("[" + scenario.id + "] run " + run + "/" + RUNS + " ...\n");
      const outcome = await runOnce({ workspace: root, prompt: scenario.prompt, registry: buildRegistry(scenario.registry), sessionId: "acc-" + scenario.id + "-" + run, ...(scenario.level ? { level: scenario.level } : {}) });
      const verdict = outcome.error ? { pass: false, detail: "error: " + outcome.error } : scenario.check(root, outcome.text);
      results.push({ id: scenario.id, run, pass: verdict.pass, detail: verdict.detail, error: outcome.error });
      process.stdout.write("  " + (verdict.pass ? "PASS" : "FAIL") + " (" + verdict.detail + ")\n");
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  const summary = scenarios.map((scenario) => {
    const rows = results.filter((r) => r.id === scenario.id);
    const passed = rows.filter((r) => r.pass).length;
    return { id: scenario.id, label: scenario.label, passed, runs: rows.length, ok: passed >= Math.ceil((rows.length + 1) / 2) };
  });
  const resultsDir = path.join(benchDir, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const outFile = path.join(resultsDir, "acceptance-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), model: MODEL, runsPerScenario: RUNS, summary, results }, null, 2), "utf8");
  process.stdout.write("\n## lazy-senior behavioral acceptance (spec 5)\n\n| Test | Label | Pass | Rule |\n|---|---|---|---|\n");
  for (const row of summary) process.stdout.write("| " + row.id + " | " + row.label + " | " + row.passed + "/" + row.runs + " | " + (row.ok ? "PASS" : "FAIL") + " (2 of 3) |\n");
  process.stdout.write("\nResults: " + outFile + "\n");
  if (summary.some((row) => !row.ok)) process.exitCode = 1;
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === new URL("file:///" + path.resolve(process.argv[1]).replaceAll("\\", "/")).href;
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write((err instanceof Error ? err.stack ?? err.message : String(err)) + "\n");
    process.exitCode = 1;
  });
}
