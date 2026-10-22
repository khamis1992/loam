/**
 * Headless coding-eval harness tests (task C18).
 *
 * The C18 suite measures the Loam coding agent on 20 small fixture repos under
 * `evals/coding/tasks/`. These tests keep both halves honest without calling a
 * model:
 *
 *   - every fixture is well-formed and fails its hidden test on the untouched
 *     baseline (so a green run really means the agent changed something), and
 *   - the runner itself behaves correctly: it materializes the sandbox, applies
 *     the reference overlay only in self-check mode, hides the grader from the
 *     agent, and enforces `requireFiles` / `forbidPatterns` / `expectExit`.
 *
 * Commands are injected, so no shell is spawned and the run is deterministic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadAllTasks, validateSuite, readTree } from "../../eval/coding/tasks.js";
import {
  HIDDEN_DIR,
  gradeTask,
  materialize,
  prepareSandbox,
  runCodingEval,
  runTask,
  scoreForMode,
  type CommandOutcome,
} from "../../eval/coding/runner.js";
import type { CodingTask } from "../../eval/coding/types.js";

/** A command runner that answers from a table, never touching a shell. */
function fakeRunner(byDir: Record<string, CommandOutcome> = {}, fallback?: CommandOutcome) {
  return async (cmd: string, opts: { cwd: string; timeoutMs: number }): Promise<CommandOutcome> => {
    const hit = byDir[path.basename(opts.cwd)] ?? fallback ?? byDir[cmd];
    assert.ok(hit, `unexpected command: ${cmd} in ${opts.cwd}`);
    return hit;
  };
}

const EXIT_0 = { code: 0, output: "", timedOut: false };
const EXIT_1 = { code: 1, output: "", timedOut: false };

/** A minimal fixture shaped like the real ones. */
function task(overrides: Partial<CodingTask> = {}): CodingTask {
  return {
    id: "task-test",
    title: "test fixture",
    category: "bug-fix",
    language: "javascript",
    prompt: "fix the bug",
    testCommand: "node .eval/check.mjs",
    files: { "src/index.js": "export const value = 1;\n" },
    tests: { "check.mjs": "import { value } from '../src/index.js';\nprocess.exit(value === 2 ? 0 : 1);\n" },
    reference: { "src/index.js": "export const value = 2;\n" },
    ...overrides,
  };
}

function tempWorkDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `coding-eval-${label}-`));
}

describe("coding eval fixtures", () => {
  it("loads 20 fixtures and validates the whole suite", () => {
    const tasks = loadAllTasks();
    assert.equal(tasks.length, 20, `expected 20 fixtures, found ${tasks.length}`);
    const { tasks: validated, errors } = validateSuite();
    assert.deepEqual(errors, [], `invalid fixtures: ${errors.map((e) => e.id).join(", ")}`);
    assert.equal(validated.length, tasks.length);
  });

  it("gives every fixture a distinct id, title and prompt", () => {
    const tasks = loadAllTasks();
    assert.equal(new Set(tasks.map((t) => t.task.id)).size, tasks.length);
    assert.equal(new Set(tasks.map((t) => t.task.title)).size, tasks.length);
    assert.equal(new Set(tasks.map((t) => t.task.prompt)).size, tasks.length);
  });

  it("covers all three categories and all three languages", () => {
    const tasks = loadAllTasks().map((t) => t.task);
    for (const category of ["bug-fix", "refactor", "add-test"]) {
      assert.ok(tasks.some((t) => t.category === category), `no fixture in category ${category}`);
    }
    for (const language of ["javascript", "typescript", "python"]) {
      assert.ok(tasks.some((t) => t.language === language), `no fixture in language ${language}`);
    }
  });

  it("names a non-empty prompt, command and every tree", () => {
    for (const { task: t } of loadAllTasks()) {
      assert.ok(t.prompt.trim().length > 0, `${t.id} has no prompt`);
      assert.ok(t.testCommand.trim().length > 0, `${t.id} has no testCommand`);
      assert.ok(Object.keys(t.files).length > 0, `${t.id} has no files/`);
      assert.ok(Object.keys(t.tests).length > 0, `${t.id} has no tests/`);
      assert.ok(Object.keys(t.reference).length > 0, `${t.id} has no reference/`);
    }
  });

  it("materializes its trees on disk and reads them back identically", () => {
    for (const { task: t } of loadAllTasks()) {
      const dir = tempWorkDir("trees");
      try {
        materialize(dir, t.files);
        assert.deepEqual(readTree(dir), t.files, `${t.id} files/ did not round-trip`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("fails its hidden test on the untouched baseline", async () => {
    const workDir = tempWorkDir("baseline");
    try {
      for (const { task: t } of loadAllTasks()) {
        const sandbox = prepareSandbox(workDir, t);
        const graded = await gradeTask(t, sandbox, fakeRunner({}, EXIT_1));
        // The untouched tree must not already satisfy the hidden tests.
        assert.equal(graded.ok, false, `${t.id}: hidden test already passes without a fix`);
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("passes every fixture when the reference solution is applied", async () => {
    const workDir = tempWorkDir("selfcheck");
    try {
      for (const { task: t } of loadAllTasks()) {
        const sandbox = prepareSandbox(workDir, t, t.reference);
        const graded = await gradeTask(t, sandbox, fakeRunner({}, EXIT_0));
        assert.equal(graded.ok, true, `${t.id}: reference solution did not satisfy the hidden test`);
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("coding eval runner", () => {
  it("applies the reference overlay only in self-check mode", async () => {
    // Each case needs its own work dir: a sandbox path is derived from the task
    // id, so sharing a work dir across cases would collide.
    const overlayDir = tempWorkDir("overlay");
    const baselineDir = tempWorkDir("baseline-invert");
    const wrongDir = tempWorkDir("baseline-pass");
    try {
      const passing = await runTask(task(), { mode: "self-check", workDir: overlayDir, run: fakeRunner({}, EXIT_0) });
      assert.equal(passing.status, "pass", "reference overlay should pass");
      assert.ok(fs.readFileSync(path.join(overlayDir, "task-test", "src", "index.js"), "utf8").includes("value = 2"));

      const untouched = await runTask(task(), { mode: "baseline", workDir: baselineDir, run: fakeRunner({}, EXIT_1) });
      // `runTask` reports the raw grading; the baseline inversion happens in
      // `scoreForMode`, which `runCodingEval` applies before aggregation.
      assert.equal(untouched.status, "fail");
      const inverted = scoreForMode("baseline", untouched);
      assert.equal(inverted.status, "pass", "baseline inverts a failing test into a meaningful fixture");
      assert.equal(inverted.checks.at(-1)?.name, "fixture-is-meaningful");

      const wrong = await runTask(task(), { mode: "baseline", workDir: wrongDir, run: fakeRunner({}, EXIT_0) });
      const notMeaningful = scoreForMode("baseline", wrong);
      assert.equal(notMeaningful.status, "fail", "a fixture whose baseline already passes is not meaningful");
      assert.equal(notMeaningful.checks.at(-1)?.ok, false);
      // Other modes must not be rewritten by the baseline contract.
      assert.equal(scoreForMode("self-check", wrong).status, "pass");
    } finally {
      for (const dir of [overlayDir, baselineDir, wrongDir]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps hidden tests out of the tree while the agent runs", () => {
    const workDir = tempWorkDir("hidden");
    try {
      const sandbox = prepareSandbox(workDir, task());
      assert.equal(fs.existsSync(path.join(sandbox, HIDDEN_DIR)), false, "grader leaked into the agent sandbox");
      assert.equal(fs.existsSync(path.join(sandbox, "check.mjs")), false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("supplies an ESM package.json only when the fixture has none", () => {
    const workDir = tempWorkDir("esm");
    try {
      const sandbox = prepareSandbox(workDir, task());
      assert.ok(fs.existsSync(path.join(sandbox, "package.json")), "no package.json written");
      const withPackage = prepareSandbox(workDir, task({ files: { ...task().files, "package.json": '{ "name": "fixture" }\n' } }));
      const body = fs.readFileSync(path.join(withPackage, "package.json"), "utf8");
      assert.equal(body.trim(), '{ "name": "fixture" }', "existing package.json was overwritten");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("enforces requireFiles before running the command", async () => {
    const workDir = tempWorkDir("require");
    try {
      const t = task({ requireFiles: ["test/extra.test.mjs"] });
      const sandbox = prepareSandbox(workDir, t);
      let commandRan = false;
      const run = async (): Promise<CommandOutcome> => {
        commandRan = true;
        return EXIT_0;
      };
      const graded = await gradeTask(t, sandbox, run);
      assert.equal(graded.ok, false);
      assert.equal(commandRan, true, "grading should still attempt the command");
      assert.equal(graded.checks.find((c) => c.name === "require:test/extra.test.mjs")?.ok, false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("enforces forbidPatterns against the post-run tree", async () => {
    const workDir = tempWorkDir("forbid");
    try {
      const t = task({ forbidPatterns: [{ path: "src/index.js", pattern: "value = 1" }] });
      const sandbox = prepareSandbox(workDir, t);
      const graded = await gradeTask(t, sandbox, fakeRunner({}, EXIT_0));
      assert.equal(graded.ok, false, "forbidden pattern should fail grading");
      assert.equal(graded.checks.find((c) => c.name.startsWith("forbid:"))?.ok, false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("honours a non-zero expectExit", async () => {
    const workDir = tempWorkDir("exit");
    try {
      const t = task({ expectExit: 3 });
      const sandbox = prepareSandbox(workDir, t);
      const graded = await gradeTask(t, sandbox, fakeRunner({}, { code: 3, output: "", timedOut: false }));
      assert.equal(graded.ok, true, "exit 3 was expected");
      assert.equal(graded.checks.find((c) => c.name === "test-command")?.ok, true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("aggregates pass@1 and reports skipped tasks separately", async () => {
    const workDir = tempWorkDir("aggregate");
    try {
      const report = await runCodingEval({
        mode: "baseline",
        workDir,
        only: ["task-001", "task-002"],
        run: async (_cmd, opts) => (path.basename(opts.cwd) === "task-001" ? EXIT_1 : EXIT_0),
      });
      assert.equal(report.total, 2);
      assert.equal(report.passed, 1);
      assert.equal(report.failed, 1);
      assert.equal(report.passAt1, 0.5);
      assert.deepEqual(report.results.map((r) => r.id), ["task-001", "task-002"]);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("marks agent mode without a runtime as an error rather than crashing", async () => {
    const workDir = tempWorkDir("noruntime");
    try {
      const result = await runTask(task(), { mode: "agent", workDir });
      assert.equal(result.status, "error");
      assert.match(result.error ?? "", /requires a runtime/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("skips tasks after the signal aborts", async () => {
    const workDir = tempWorkDir("abort");
    try {
      const controller = new AbortController();
      controller.abort();
      const report = await runCodingEval({ mode: "baseline", workDir, only: ["task-001"], signal: controller.signal });
      assert.equal(report.skipped, 1);
      assert.equal(report.passAt1, 0);
      assert.equal(report.results[0]?.status, "skipped");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("fixture prompt hygiene", () => {
  it("uses English prompts only", () => {
    // The suite is the shared measuring stick, so every prompt must be readable
    // and unambiguous; reject anything outside printable ASCII.
    for (const { task: t } of loadAllTasks()) {
      assert.ok(/^[\x20-\x7e]*$/.test(t.prompt), `${t.id} prompt contains non-ASCII characters`);
    }
  });

  it("does not reference its own hidden tests in the prompt", () => {
    for (const { task: t } of loadAllTasks()) {
      assert.ok(!t.prompt.includes(HIDDEN_DIR), `${t.id} prompt leaks the hidden directory`);
      for (const rel of Object.keys(t.tests)) {
        const base = path.basename(rel);
        if (base === "check.mjs" || base === "check.py") continue;
        assert.ok(!t.prompt.includes(base), `${t.id} prompt names hidden test file ${base}`);
      }
    }
  });
});
