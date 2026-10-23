/**
 * The scripted model behind the long-horizon gate (N20).
 *
 * A long-horizon eval needs a model that is *honest about being weak*: it must
 * be capable of finishing a multi-round task, but it must also be able to fail
 * in the specific ways the gate wants to measure (a hallucinated citation, an
 * unbounded transcript, a tool failure it cannot work around). A real local
 * model is nondeterministic and slow; a scripted one is neither. The fixture
 * author describes the behaviour, and the model replays it.
 *
 * A {@link NeoModelScript} is a list of turns. Each turn is one assistant reply:
 * a piece of text and zero or more tool calls. The harness asks for the next
 * turn only after the previous calls have been executed, exactly like the real
 * agent loop, so the mock is driven through the same state machine. The loop's
 * own verifier then asks the same client for its verdict, which lets a fixture
 * model a refusal or an acceptance without a second fake client.
 */
import fs from "node:fs";
import type { ChatMessage, ChatOptions, ChatResult, OllamaClient, OllamaToolCall } from "../ollama.js";
import type { NeoModelScript, NeoScriptRuntime, NeoScriptStep } from "./types.js";

/** Rough characters-per-token ratio used for the harness's token accounting. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Attach a grounded `finalAnswer` to a scripted verifier verdict.
 *
 * The production verifier only promotes a verdict to the user-visible answer
 * when its JSON carries a non-empty `finalAnswer`; prose alone is dropped. A
 * fixture's script is plain text, so the harness supplies the answer from the
 * artifact the verifier just inspected. `{EXCERPT}` is replaced with the body
 * of the most recent tool result (the read-back of the captured artifact), with
 * the `file_read` path header and line numbers stripped so the answer reads as
 * the artifact's own content.
 */
function attachFinalAnswer(text: string, template: string, excerptSource: string): string {
  const excerpt = excerptSource
    .replace(/^\S+\s*\(\d+ lines\)\n/, "")
    .split("\n")
    .map((line) => line.replace(/^\d+:\s/, ""))
    .join("\n")
    .trim()
    .slice(0, 2000);
  const answer = template.split("{EXCERPT}").join(excerpt);
  const trimmed = text.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...(parsed as Record<string, unknown>), finalAnswer: answer });
    }
  } catch {
    /* not JSON: the verdict is still parsed by keyword, so leave it alone */
  }
  return text;
}

/** Identifiers are stable so a rerun produces byte-identical transcripts. */
let callCounter = 0;

function toolCallId(): string {
  callCounter += 1;
  return `call_${callCounter.toString(36).padStart(6, "0")}`;
}

export interface NeoMockModelOptions {
  /** Script to replay for executor turns. */
  script: NeoModelScript;
  /** Script to replay for verifier turns (the loop calls `verifyFinal`). */
  verifierScript?: NeoModelScript;
  /**
   * Fault injection, applied to every tool call (executor and verifier).
   * Return a message to fail the call, or undefined to let it through.
   */
  onCall?: (tool: string, args: Record<string, unknown>, runtime: NeoScriptRuntime) => string | undefined;
  /**
   * Template for the `finalAnswer` the verifier's pass verdict is grounded in.
   * `{EXCERPT}` is replaced with the body of the last inspected artifact.
   */
  verifierAnswer?: string;
  /** Model id reported in usage/events. */
  model?: string;
  /** Verifier model id. Defaults to the executor model. */
  verifierModel?: string;
  /** Workspace path used by `onCall` guards that probe the disk. */
  workspace?: string;
  /** Override the assembled system prompt (fixes a small, bounded prompt). */
  systemOverride?: string;
  /** Append to every executor step's prompt (models a growing document). */
  growthPerStep?: number;
}

/**
 * A deterministic model client that replays scripts.
 *
 * It exposes the same surface as {@link OllamaClient} so the agent loop under
 * test cannot tell the difference beyond the scripted content. `OllamaClient`
 * is nominally typed (it declares a private field), so an unrelated class can
 * never `implements` it; the harness casts the mock at the injection boundary,
 * the same way the loop's own tests fake a client.
 */
export class NeoMockModel {
  readonly model: string;
  private readonly executorScript: NeoScriptStep[];
  private readonly verifierScript: NeoScriptStep[];
  private readonly onCall?: (tool: string, args: Record<string, unknown>, runtime: NeoScriptRuntime) => string | undefined;
  private readonly verifierAnswer?: string;
  private readonly verifierModel: string;
  private readonly workspace: string;
  private readonly systemOverride?: string;
  private readonly growthPerStep: number;
  private readonly promptTokens: number[] = [];
  private executorStep = 0;
  private verifierStep = 0;
  private inVerifier = false;
  private verifierUsage = { promptTokens: 0, completionTokens: 0, durationMs: 0 };
  private readonly calls: Array<{ name: string; args: Record<string, unknown>; ok: boolean }> = [];
  private runtime: NeoScriptRuntime;

  constructor(private readonly options: NeoMockModelOptions) {
    this.executorScript = options.script.steps;
    this.verifierScript = options.verifierScript?.steps ?? [];
    this.onCall = options.onCall;
    this.verifierAnswer = options.verifierAnswer;
    this.model = options.model ?? "neo-mock";
    this.verifierModel = options.verifierModel ?? this.model;
    this.workspace = options.workspace ?? process.cwd();
    this.systemOverride = options.systemOverride;
    this.growthPerStep = options.growthPerStep ?? 0;
    this.runtime = { atStep: 0, calls: 0, fileExists: (p) => false };
  }

  /** Number of executor turns already produced. */
  get stepCount(): number {
    return this.executorStep;
  }

  /**
   * Reset the script cursors for a fresh round.
   *
   * A recurring fixture runs one agent run per round against the same model
   * instance, so each round must replay the script from its first turn rather
   * than continuing past the end of it. The call log resets with it, because the
   * `when` guards and the `onCall` runtime both describe the round in progress.
   */
  resetForRound(): void {
    this.executorStep = 0;
    this.verifierStep = 0;
    this.inVerifier = false;
    this.calls.length = 0;
  }

  /** Prompt-token samples recorded for executor turns, in order. */
  get promptTokenSamples(): readonly number[] {
    return this.promptTokens;
  }

  /** Tool calls dispatched, with their injected outcome. */
  get toolCalls(): ReadonlyArray<{ name: string; args: Record<string, unknown>; ok: boolean }> {
    return this.calls;
  }

  private nextStep(): { step: NeoScriptStep; index: number } {
    const list = this.inVerifier ? this.verifierScript : this.executorScript;
    let index = this.inVerifier ? this.verifierStep : this.executorStep;
    const start = index;
    while (index < list.length) {
      const step = list[index]!;
      const when = step.when;
      if (when && !this.matches(step, when)) {
        index += 1;
        continue;
      }
      return { step, index };
    }
    // The cursor has to advance past every turn skipped by a `when` guard, or a
    // turn that only becomes eligible after the next call would leave the script
    // exhausted and the model would fall back to empty text.
    if (index > start) {
      if (this.inVerifier) this.verifierStep = index;
      else this.executorStep = index;
    }
    return { step: { text: "" }, index: index };
  }

  private matches(step: NeoScriptStep, when: NonNullable<NeoScriptStep["when"]>): boolean {
    const seen = new Map<string, number[]>();
    this.calls.forEach((call, i) => {
      const list = seen.get(call.name) ?? [];
      list.push(i);
      seen.set(call.name, list);
    });

    if (when.afterCall !== undefined) {
      const list = seen.get(when.afterCall);
      if (!list || list.length === 0) return false;
      if (when.within !== undefined) {
        const last = list[list.length - 1]!;
        // `within: 1` means "the last turn"; 2 means "the turn before that".
        const window = this.calls.slice(Math.max(0, last - (when.within - 1)), last + 1);
        if (!window.some((c) => c.name === when.afterCall)) return false;
      }
    }

    if (when.afterFail !== undefined) {
      const failed = this.calls.findIndex((c) => c.name === when.afterFail && !c.ok);
      if (failed < 0) return false;
      if (when.within !== undefined) {
        const window = this.calls.slice(Math.max(0, failed - (when.within - 1)), failed + 1);
        if (!window.some((c) => c.name === when.afterFail && !c.ok)) return false;
      }
    }

    if (when.minCalls !== undefined && this.calls.length < when.minCalls) return false;
    return true;
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const incoming = options.messages ?? [];
    const isVerifierTurn = this.isVerifierCall(incoming);
    this.inVerifier = isVerifierTurn;

    const { step, index } = this.nextStep();
    if (isVerifierTurn) this.verifierStep = index + 1;
    else this.executorStep = index + 1;

    // The body of the most recent tool result, so a verifier turn can ground its
    // final answer in what it actually inspected.
    const lastTool = [...incoming].reverse().find((m) => m.role === "tool");
    const lastToolContent = typeof lastTool?.content === "string" ? lastTool.content : "";

    this.runtime = {
      atStep: index,
      calls: this.calls.length,
      fileExists: (p) => {
        if (!p) return false;
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      },
    };

    // Grow the prompt the fixture asks for, so flatness has something to measure.
    const growth = this.growthPerStep * (isVerifierTurn ? 0 : index);
    let content = step.text ?? "";
    if (isVerifierTurn && step.finalAnswerFromToolResult !== undefined) {
      content = attachFinalAnswer(content, step.finalAnswerFromToolResult, lastToolContent);
    }
    const toolCalls: OllamaToolCall[] = (step.calls ?? []).map((call) => ({
      id: toolCallId(),
      function: { name: call.tool, arguments: call.args ?? {} },
    }));

    for (const call of step.calls ?? []) {
      const injected = this.onCall?.(call.tool, call.args ?? {}, this.runtime);
      this.calls.push({ name: call.tool, args: call.args ?? {}, ok: injected === undefined });
    }

    const promptText = incoming.map((m) => m.content).join("\n");
    const promptTokens =
      step.promptTokens ?? estimateTokens(promptText) + (growth > 0 ? estimateTokens("x".repeat(growth)) : 0);
    if (!isVerifierTurn) this.promptTokens.push(promptTokens);

    const usage = {
      promptTokens,
      completionTokens: estimateTokens(content) + toolCalls.length * 8,
      durationMs: 0,
    };
    if (isVerifierTurn) {
      this.verifierUsage.promptTokens += usage.promptTokens;
      this.verifierUsage.completionTokens += usage.completionTokens;
    }
    return { content, toolCalls, model: isVerifierTurn ? this.verifierModel : this.model, doneReason: "stop", usage };
  }

  /**
   * The loop's verifier runs with a system prompt built from `VERIFY_SYSTEM`;
   * the executor runs with the assembled master prompt. Distinguishing on the
   * system content keeps the two scripts independent.
   */
  private isVerifierCall(incoming: readonly ChatMessage[]): boolean {
    const system = incoming.find((m) => m.role === "system")?.content ?? "";
    if (this.systemOverride !== undefined) return false;
    return /critic of an actor-critic loop|You judge the COMPLETED task as a whole/.test(system);
  }

  /** The mock has no real endpoint; `url` keeps the client contract. */
  get baseUrl(): string {
    return "neo-mock://localhost";
  }

  async listModels(): Promise<string[]> {
    return [this.model];
  }

  /** Offline mock: the local model list is the scripted model itself. */
  async listLocalModels(): Promise<string[]> {
    return [this.model];
  }

  /** No cloud provider is configured for a scripted run. */
  async listCloudModels(): Promise<string[]> {
    return [];
  }

  cloudHeaders(): Record<string, string> {
    return { "content-type": "application/json" };
  }

  hasCloudKey(): boolean {
    return false;
  }

  url(p: string): string {
    return `neo-mock:${p}`;
  }

  async chatLocal(): Promise<ChatResult> {
    throw new Error("NeoMockModel.chatLocal is not used");
  }

  async chatCloud(): Promise<ChatResult> {
    throw new Error("NeoMockModel.chatCloud is not used");
  }
}

/**
 * A no-op model client that always refuses. Used by fixtures that only exercise
 * the harness plumbing (a run that must stop immediately).
 */
export class NeoRefusingModel {
  readonly model = "neo-refusing";
  constructor(private readonly reason = "model unavailable") {}

  async chat(): Promise<ChatResult> {
    throw new Error(this.reason);
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async listLocalModels(): Promise<string[]> {
    return [];
  }

  async listCloudModels(): Promise<string[]> {
    return [];
  }

  cloudHeaders(): Record<string, string> {
    return { "content-type": "application/json" };
  }

  hasCloudKey(): boolean {
    return false;
  }

  get baseUrl(): string {
    return "neo-refusing://localhost";
  }

  url(p: string): string {
    return `neo-refusing:${p}`;
  }

  async chatLocal(): Promise<ChatResult> {
    throw new Error(this.reason);
  }

  async chatCloud(): Promise<ChatResult> {
    throw new Error(this.reason);
  }
}
