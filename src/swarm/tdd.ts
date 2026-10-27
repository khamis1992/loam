/**
 * Test-first guard for planned task nodes (BUILD_SPEC §6.4, proposal 4).
 *
 * A per-task state machine fed by the stage's tool wrapper. Method only from
 * TDD Guard and Superpowers (both MIT); no code is copied. Rules:
 *  - test files and support files (docs, config, styles) may always be written;
 *  - application code may be written only after a test file of this task was
 *    written AND a verification command ran afterwards (red, or already green
 *    for behaviour that exists);
 *  - the task completes only when a verification command passed after the
 *    last code write.
 */
import path from "node:path";

export type TddPhase = "need-test" | "need-run" | "coding" | "verified";

export interface TddSnapshot {
  phase: TddPhase;
  testsWritten: string[];
  redObserved: boolean;
  greenAfterLastCode: boolean;
  codeWrites: number;
  blockedWrites: number;
}

const SUPPORT_FILE = /\.(?:md|markdown|txt|json|ya?ml|toml|css|scss|svg|png|jpe?g|gif|ico|webp|woff2?|lock)$/i;
const SUPPORT_BASENAMES = new Set([".gitignore", ".editorconfig", ".npmrc", ".nvmrc", "license", "readme"]);
const INFRA_FAILURE = /timeout, killed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i;

export class TddGuard {
  private phase: TddPhase;
  private readonly testsWritten = new Set<string>();
  private redObserved = false;
  private greenAfterLastCode = false;
  private codeWrites = 0;
  private blockedWrites = 0;

  constructor(private readonly opts: { exempt: boolean; isTestPath: (rel: string) => boolean; plannedTests: readonly string[] }) {
    this.phase = opts.exempt ? "coding" : "need-test";
  }

  /** True for files that never need a test first. */
  static isSupportFile(rel: string): boolean {
    const base = path.posix.basename(rel.replaceAll("\\", "/")).toLowerCase();
    return SUPPORT_FILE.test(base) || SUPPORT_BASENAMES.has(base) || SUPPORT_BASENAMES.has(base.replace(/\.[^.]+$/, ""));
  }

  /** Decides a write before it happens. The message explains the missing step. */
  beforeWrite(rel: string): { allow: true } | { allow: false; message: string } {
    if (this.opts.exempt || this.opts.isTestPath(rel) || TddGuard.isSupportFile(rel)) return { allow: true };
    if (this.phase === "need-test") {
      this.blockedWrites++;
      return { allow: false, message: `TEST FIRST: write the failing test before application code. Create ${this.opts.plannedTests.join(", ") || "this task's test file"} first, then run it alone with shell_run.` };
    }
    if (this.phase === "need-run") {
      this.blockedWrites++;
      return { allow: false, message: `RUN THE TEST FIRST: you wrote ${[...this.testsWritten].join(", ")} but have not run it. Run it alone with shell_run (for example node --test ${[...this.testsWritten][0] ?? "<test file>"}) and read the failure before writing code.` };
    }
    return { allow: true };
  }

  /** Records a completed write. */
  afterWrite(rel: string, ok: boolean): void {
    if (!ok) return;
    if (this.opts.isTestPath(rel)) {
      this.testsWritten.add(rel);
      if (this.phase === "need-test") this.phase = "need-run";
      this.greenAfterLastCode = false;
      return;
    }
    if (TddGuard.isSupportFile(rel)) return;
    this.codeWrites++;
    this.greenAfterLastCode = false;
    if (this.phase === "verified") this.phase = "coding";
  }

  /** Records a recognized verification command result. Infrastructure failures are ignored. */
  afterVerification(ok: boolean, output: string): void {
    if (!ok && INFRA_FAILURE.test(output)) return;
    if (this.phase === "need-run") { this.phase = "coding"; if (!ok) this.redObserved = true; }
    else if (!ok && this.codeWrites === 0) this.redObserved = true;
    if (ok && this.phase === "coding") { this.greenAfterLastCode = true; if (this.codeWrites > 0 || this.opts.exempt) this.phase = "verified"; }
    if (ok && this.phase === "verified") this.greenAfterLastCode = true;
  }

  /** The completion check run when the task's model answers. */
  finish(): { ok: true } | { ok: false; reason: string } {
    if (this.opts.exempt) return { ok: true };
    if (!this.testsWritten.size) return { ok: false, reason: "no test file was written for this task" };
    if (!this.greenAfterLastCode) return { ok: false, reason: "no passing verification run after the last code change" };
    return { ok: true };
  }

  snapshot(): TddSnapshot {
    return { phase: this.phase, testsWritten: [...this.testsWritten], redObserved: this.redObserved, greenAfterLastCode: this.greenAfterLastCode, codeWrites: this.codeWrites, blockedWrites: this.blockedWrites };
  }
}
