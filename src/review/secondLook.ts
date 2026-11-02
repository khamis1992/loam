import type { DatabaseSync } from "node:sqlite";
import { collectChangedFiles, type ChangedFile } from "./changedFiles.js";
import { reviewerSystemPrompt, reviewerUserPrompt } from "./reviewerPrompt.js";
import { copyWorkspace, removeCopy } from "./sandboxCopy.js";
import { detectRuntimes, runProbe, type ProbeRuntime } from "./probeRunner.js";
import { parseVerdict } from "./verdict.js";
import type { TextModel } from "../memory/recall/types.js";
import { newId } from "../memory/recall/vectors.js";

export type ReviewMode = "off" | "read" | "run";

export interface ReviewPolicy {
  defaultMode: ReviewMode;
  modes: Record<string, ReviewMode>;
  maxFiles: number;
  maxCharsPerFile: number;
  maxTotalChars: number;
  maxRequestChars: number;
  maxFindings: number;
  maxFindingsChars: number;
  readTimeoutMs: number;
  runTimeoutMs: number;
  probeTimeoutMs: number;
  maxRounds: number;
  copyLimits: { maxFiles: number; maxBytes: number };
  numCtx: number;
  thinking: boolean;
}

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  defaultMode: "read",
  modes: { build: "read", write: "read", data: "read", legal: "read", research: "off", ask: "off", chat: "off" },
  maxFiles: 8,
  maxCharsPerFile: 12_000,
  maxTotalChars: 40_000,
  maxRequestChars: 6000,
  maxFindings: 5,
  maxFindingsChars: 2500,
  readTimeoutMs: 90_000,
  runTimeoutMs: 180_000,
  probeTimeoutMs: 20_000,
  maxRounds: 6,
  copyLimits: { maxFiles: 3000, maxBytes: 64 * 1024 * 1024 },
  numCtx: 32768,
  thinking: false,
};

export interface ReviewInput {
  runId: string;
  mode: string;
  workspace: string;
  requests: string[];
  reply: string;
  turnStartedAt: number;
  touched: string[];
  toolCalls: number;
  depth: number;
  aborted: boolean;
  alreadyReviewed: boolean;
}

export type ReviewOutcome =
  | { status: "skipped"; reason: "no_changes" | "off" | "subagent" | "aborted" | "too_large" | "already_reviewed" | "no_tools" }
  | { status: "lgtm"; ms: number; promptTokens: number; completionTokens: number }
  | { status: "findings"; findings: string[]; ms: number; promptTokens: number; completionTokens: number }
  | { status: "error"; error: string; ms: number };

export function modeFor(policy: ReviewPolicy, loamMode: string): ReviewMode {
  const configured = policy.modes[loamMode] ?? policy.defaultMode;
  if (loamMode === "legal" && configured === "run") return "read";
  return configured;
}

export function harnessNote(findings: string[]): string {
  return [
    "[second_look]",
    "A fresh reviewer found concrete issues. Fix the real ones and briefly explain any you reject.",
    ...findings.slice(0, 5).map((item, index) => `${index + 1}. ${item}`),
  ].join("\n");
}

export async function secondLook(input: ReviewInput, model: TextModel, policy: ReviewPolicy, db?: DatabaseSync): Promise<ReviewOutcome> {
  const started = Date.now();
  const reviewMode = modeFor(policy, input.mode);
  if (input.depth > 0) return skipped("subagent");
  if (input.aborted) return skipped("aborted");
  if (input.alreadyReviewed) return skipped("already_reviewed");
  if (reviewMode === "off") return skipped("off");
  if (input.toolCalls < 1) return skipped("no_tools");
  const files = collectChangedFiles({
    workspace: input.workspace,
    turnStartedAt: input.turnStartedAt,
    ledger: input.touched,
    limits: { maxFiles: policy.maxFiles, maxCharsPerFile: policy.maxCharsPerFile, maxTotalChars: policy.maxTotalChars },
  });
  if (files.length === 0) return skipped("no_changes");
  try {
    const outcome = reviewMode === "run"
      ? await runReview(input, files, model, policy)
      : await readReview(input, files, model, policy);
    record(db, input, reviewMode, files.length, outcome);
    return outcome;
  } catch (error) {
    const failed: ReviewOutcome = { status: "error", error: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
    record(db, input, reviewMode, files.length, failed);
    return failed;
  }
}

function skipped(reason: "no_changes" | "off" | "subagent" | "aborted" | "too_large" | "already_reviewed" | "no_tools"): ReviewOutcome {
  return { status: "skipped", reason };
}

async function readReview(input: ReviewInput, files: ChangedFile[], model: TextModel, policy: ReviewPolicy): Promise<ReviewOutcome> {
  const started = Date.now();
  const result = await model.complete(
    reviewerSystemPrompt(),
    reviewerUserPrompt(input.requests, input.reply, files.map((file) => ({ path: file.relPath, body: file.binary ? `(binary ${file.relPath})` : file.content }))),
    { temperature: 0.2, timeoutMs: policy.readTimeoutMs, numCtx: policy.numCtx },
  );
  return fromText(result.text, result.promptTokens, result.completionTokens, Date.now() - started, policy);
}

async function runReview(input: ReviewInput, files: ChangedFile[], model: TextModel, policy: ReviewPolicy): Promise<ReviewOutcome> {
  const started = Date.now();
  const copied = copyWorkspace(input.workspace, input.runId, policy.copyLimits);
  if ("skipped" in copied) return { status: "skipped", reason: "too_large" };
  const runtimes = detectRuntimes();
  let promptTokens = 0;
  let completionTokens = 0;
  let last = "";
  try {
    let transcript = reviewerUserPrompt(input.requests, input.reply, files.map((file) => ({ path: file.relPath, body: file.binary ? `(binary ${file.relPath})` : file.content })));
    for (let round = 1; round <= policy.maxRounds; round++) {
      if (Date.now() - started > policy.runTimeoutMs) break;
      const force = round === policy.maxRounds;
      const result = await model.complete(
        `${reviewerSystemPrompt()}\nYou may request a probe as JSON {"tool":"read_file"|"run","path"?:string,"runtime"?:${runtimes.map((item) => `"${item}"`).join("|")},"source"?:string}. On the last round, give only the verdict. Reproduce defects; do not only re-run the project's tests. Network is unavailable.`,
        force ? `${transcript}\n\nFinal round. Reply with the verdict only.` : transcript,
        { temperature: 0.2, timeoutMs: Math.min(policy.readTimeoutMs, policy.runTimeoutMs - (Date.now() - started)), numCtx: policy.numCtx },
      );
      promptTokens += result.promptTokens;
      completionTokens += result.completionTokens;
      last = result.text;
      if (force || /VERDICT:/i.test(result.text)) break;
      const tool = result.text.match(/\{[\s\S]*\}/);
      if (!tool) break;
      let parsed: { tool?: string; path?: string; runtime?: string; source?: string };
      try { parsed = JSON.parse(tool[0]) as typeof parsed; } catch { break; }
      if (parsed.tool === "read_file" && parsed.path) {
        const file = files.find((item) => item.relPath === parsed.path);
        transcript += `\nProbe read ${parsed.path}:\n${(file?.content ?? "(missing)").slice(0, 20_000)}`;
      } else if (parsed.tool === "run" && parsed.source && runtimes.includes(parsed.runtime as ProbeRuntime)) {
        const probe = await runProbe({ cwd: copied.dir, runtime: parsed.runtime as ProbeRuntime, source: parsed.source, timeoutMs: policy.probeTimeoutMs });
        transcript += `\nProbe ${parsed.runtime} timedOut=${probe.timedOut} code=${probe.code}:\n${probe.stdout}\n${probe.stderr}`;
      }
    }
    return fromText(last, promptTokens, completionTokens, Date.now() - started, policy);
  } finally {
    removeCopy(copied.dir);
  }
}

function fromText(text: string, promptTokens: number, completionTokens: number, ms: number, policy: ReviewPolicy): ReviewOutcome {
  const parsed = parseVerdict(text, policy.maxFindings, policy.maxFindingsChars);
  if (parsed.status === "lgtm") return { status: "lgtm", ms, promptTokens, completionTokens };
  if (parsed.status === "findings") return { status: "findings", findings: parsed.findings, ms, promptTokens, completionTokens };
  return { status: "error", error: parsed.error, ms };
}

function record(db: DatabaseSync | undefined, input: ReviewInput, reviewMode: ReviewMode, files: number, outcome: ReviewOutcome): void {
  if (!db || outcome.status === "skipped") return;
  db.prepare("INSERT INTO review_runs(id, run_id, mode, review_mode, files, ms, prompt_tokens, completion_tokens, verdict, findings, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    newId("rev_"),
    input.runId,
    input.mode,
    reviewMode,
    files,
    "ms" in outcome ? outcome.ms : 0,
    "promptTokens" in outcome ? outcome.promptTokens : 0,
    "completionTokens" in outcome ? outcome.completionTokens : 0,
    outcome.status,
    outcome.status === "findings" ? JSON.stringify(outcome.findings) : null,
    Date.now(),
  );
}
