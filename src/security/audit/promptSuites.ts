/**
 * Measurement suites for the audit's own role prompts (lleval consumer).
 * Each suite runs a real prompt from prompts.ts and asserts the output
 * contract the orchestrator depends on: exactly one JSON object with the
 * role's required keys, no prose, no code fence. Pure and deterministic, so
 * eval-audit-prompts drives it with the real model while tests use fakes.
 */
import { criticPrompt, dedupePrompt, hunterPrompt, reconPrompt, verifierPrompt } from "./prompts.js";
import type { EvalSuite } from "../native/lleval/evaluate.js";

/** Keys each role's answer must carry for the orchestrator to parse it. */
const REQUIRED_KEYS: Record<string, string[]> = {
  recon: ["facts", "summary"],
  hunter: ["candidates", "coverage", "checks", "unresolved"],
  verifier: ["evidence_vector", "production_viable", "reason"],
  dedupe: ["verdicts"],
  critic: ["gaps", "merge"],
};

const hasKeys = (keys: string[]): string => `
  const parsed = JSON.parse(output);
  const missing = ${JSON.stringify(keys)}.filter((k) => !(k in parsed));
  if (missing.length) return { pass: false, reason: "missing keys: " + missing.join(",") };
  return true;
`;

const FIXTURES = {
  unit: { coverage_id: "U-1", paths: ["src/app.ts"], classId: "injection" },
  candidate: JSON.stringify({
    title: "eval of user input", description: "Input reaches eval without validation.",
    trace: [{ kind: "entrypoint", file: "src/app.ts", line: 3, description: "param x" }],
    evidence: [{ file: "src/app.ts", line: 3, description: "eval(x)" }],
  }),
  pairs: JSON.stringify([[{ fingerprint: "a", title: "t" }, { fingerprint: "b", title: "t2" }]]),
  summary: JSON.stringify({ units: [{ coverage_id: "U-1", status: "covered", attempts: 1 }] }),
};

export interface SuiteOptions {
  /** Append a model-graded rubric check to every suite (needs a grader at eval time). */
  rubric?: boolean;
}

export function auditPromptSuites(opts: SuiteOptions = {}): EvalSuite[] {
  const base = (name: keyof typeof REQUIRED_KEYS, prompt: string, extraVars: Record<string, readonly string[]> = {}): EvalSuite => ({
    name: `audit-${name}`,
    prompts: [prompt],
    vars: extraVars,
    tests: [{
      description: "output contract",
      assert: [
        { type: "is-json" },
        { type: "not-contains", value: "```" },
        { type: "javascript", code: hasKeys(REQUIRED_KEYS[name]!) },
        ...(opts.rubric ? [{ type: "llm-rubric" as const, value: "The answer is exactly one JSON object with the requested keys, grounded and free of prose." }] : []),
      ],
    }],
  });

  return [
    base("recon", reconPrompt("entrypoints", ["hint: server listens on 3000"])),
    base("hunter", hunterPrompt(FIXTURES.unit, ["web-api"], [], [])),
    base("verifier", verifierPrompt(FIXTURES.candidate)),
    base("dedupe", dedupePrompt(FIXTURES.pairs)),
    base("critic", criticPrompt(FIXTURES.summary)),
  ];
}

/** Structural adapter: anything with an Ollama-style chat() becomes a lleval CallFn. */
export interface ChatLike {
  chat(opts: { model: string; messages: { role: string; content: string }[]; temperature?: number; timeoutMs?: number }): Promise<{ content: string }>;
}

export function callFromChat(client: ChatLike, model: string, timeoutMs = 120_000) {
  return async (prompt: string): Promise<{ output: string; latencyMs: number }> => {
    const started = Date.now();
    const r = await client.chat({ model, messages: [{ role: "user", content: prompt }], temperature: 0, timeoutMs });
    return { output: r.content, latencyMs: Date.now() - started };
  };
}

/** Plain ChatFn (text in, text out) for grading rubric assertions with the same client. */
export function graderFromChat(client: ChatLike, model: string, timeoutMs = 120_000) {
  return async (prompt: string): Promise<string> =>
    (await client.chat({ model, messages: [{ role: "user", content: prompt }], temperature: 0, timeoutMs })).content;
}
