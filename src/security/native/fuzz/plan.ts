/**
 * Jazzer.js run planning. The fuzzer itself runs as an external process
 * (`npx --no-install jazzer`, argv array, no shell); this only builds a
 * bounded, resource-capped command line and interprets its exit codes.
 */
export const FINDING_EXIT = 77;
export const UNEXPECTED_ERROR_EXIT = 78;

export interface JazzerPlanOptions {
  /** Fuzz target file exporting a `fuzz` function. */
  entry: string;
  corpusDir: string;
  /** libFuzzer `-runs`; a finite default keeps audit runs bounded. */
  runs?: number;
  /** libFuzzer `-rss_limit_mb`. */
  rssLimitMb?: number;
  /** Per-input timeout in milliseconds (jazzer `--timeout`). */
  timeoutMs?: number;
  /** libFuzzer `-max_len` input cap. */
  maxLen?: number;
  /** Directory crash artifacts are written to (created by the caller). */
  artifactDir?: string;
  /** Run the fuzz target synchronously (jazzer `--sync`). */
  sync?: boolean;
  /** Re-run the corpus without mutating (jazzer `--mode regression`). */
  regression?: boolean;
}

export interface JazzerPlan {
  /** argv for `npx` (or a direct node launcher); spawn without a shell. */
  argv: string[];
  /** Exit codes that still carry a usable result. */
  okCodes: number[];
}

/**
 * Bounded defaults: 5,000 executions, 2 GB RSS ceiling, 10 s per input,
 * 4 KB inputs. Every value is overridable so callers can tighten further.
 */
export const DEFAULTS = { runs: 5_000, rssLimitMb: 2_048, timeoutMs: 10_000, maxLen: 4_096 } as const;

export function jazzerPlan(o: JazzerPlanOptions): JazzerPlan {
  const runs = o.runs ?? DEFAULTS.runs;
  const rss = o.rssLimitMb ?? DEFAULTS.rssLimitMb;
  const timeoutMs = o.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxLen = o.maxLen ?? DEFAULTS.maxLen;
  const argv = ["--no-install", "jazzer", o.entry, o.corpusDir];
  if (o.sync) argv.push("--sync");
  if (o.regression) argv.push("--mode", "regression");
  // Per-input timeout goes to libFuzzer (single dash, seconds); jazzer 4.0 has no own timeout flag.
  argv.push("--", `-timeout=${Math.max(1, Math.round(timeoutMs / 1000))}`, `-runs=${runs}`, `-rss_limit_mb=${rss}`, `-max_len=${maxLen}`);
  if (o.artifactDir) argv.push(`-artifact_prefix=${o.artifactDir}${o.artifactDir.endsWith("/") || o.artifactDir.endsWith("\\") ? "" : "/"}`);
  return { argv, okCodes: [0, FINDING_EXIT] };
}

/** Human-readable meaning of a jazzer exit code, or null when the run simply failed. */
export function exitMeaning(code: number | null): string | null {
  if (code === 0) return "clean run";
  if (code === FINDING_EXIT) return "fuzzing found a crash or a bug-detector hit";
  if (code === UNEXPECTED_ERROR_EXIT) return "unexpected fuzzing error (not a target finding)";
  return null;
}
