import type { Config } from "../config.js";
import type { OllamaClient, ChatMessage } from "../ollama.js";
import type { Emit, Usage } from "./events.js";
import { buildSystemPrompt, loadSkills } from "./prompt.js";
import { SKILLS_DIR } from "../config.js";
import type { ToolRegistry } from "../tools/registry.js";
import { chatWithFallback } from "./model.js";
import { throwIfCancelled } from "../server/runControl.js";

export interface RunOptions {
  cfg: Config;
  ollama: OllamaClient;
  tools: ToolRegistry;
  emit: Emit;
  prompt: string;
  history?: ChatMessage[];
  memories?: Array<{ text: string; score: number }>;
  signal?: AbortSignal;
  /** Active task id — lets long-running tools poll for cancellation. */
  taskId?: string;
  /** When set, replaces the default system prompt (used by the background reviewer). */
  systemOverride?: string;
  /** Appended after the built (or overridden) system prompt. Used by orchestrator workers. */
  systemSuffix?: string;
  /** Overrides cfg.agent.maxSteps for this run (orchestrator workers get a tighter budget). */
  maxSteps?: number;
  /** Skip the terminal assistant_message/done events (the orchestrator emits its own). */
  suppressFinal?: boolean;
}

export interface RunResult {
  text: string;
  messages: ChatMessage[];
  steps: number;
  model: string;
  usage: Usage;
}

function normalizeArgs(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function summarize(text: string, lines = 10): string {
  const trimmed = text.trim();
  const parts = trimmed.split(/\r?\n/).slice(0, lines);
  return parts.join("\n").slice(0, 600);
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const baseSystem =
    opts.systemOverride ??
    buildSystemPrompt(opts.cfg, loadSkills(SKILLS_DIR), opts.tools.names(), opts.memories ?? []);
  const system =
    opts.systemSuffix && opts.systemSuffix.trim().length > 0
      ? `${baseSystem}\n\n${opts.systemSuffix.trim()}`
      : baseSystem;
  const messages: ChatMessage[] = [{ role: "system", content: system }];

  if (opts.history && opts.history.length > 0) {
    for (const m of opts.history.slice(-12)) messages.push(m);
  }
  messages.push({ role: "user", content: opts.prompt });

  let finalText = "";
  let usedModel = opts.cfg.model;
  let step = 0;
  const usage = { promptTokens: 0, completionTokens: 0, durationMs: 0 };
  const maxSteps = opts.maxSteps !== undefined && opts.maxSteps > 0 ? opts.maxSteps : opts.cfg.agent.maxSteps;

  for (step = 1; step <= maxSteps; step++) {
    // Stop immediately when the user pressed the cancel button (checked between every step).
    throwIfCancelled(opts.signal, opts.taskId);
    opts.emit({ type: "step", index: step });

    const result = await chatWithFallback({
      cfg: opts.cfg,
      ollama: opts.ollama,
      messages,
      tools: opts.tools.toOllama(),
      temperature: opts.cfg.agent.temperature,
      signal: opts.signal,
      onToken: (t) => {
        if (opts.suppressFinal !== true) opts.emit({ type: "assistant_token", text: t });
      },
      notify: (message) => opts.emit({ type: "error", message }),
    });
    throwIfCancelled(opts.signal, opts.taskId);
    usedModel = result.model;
    usage.promptTokens += result.usage.promptTokens;
    usage.completionTokens += result.usage.completionTokens;
    usage.durationMs += result.usage.durationMs;

    if (result.toolCalls.length === 0) {
      finalText = result.content.trim();
      if (!finalText) throw new Error("model returned an empty answer");
      if (opts.suppressFinal !== true) {
        opts.emit({ type: "assistant_message", text: finalText });
        opts.emit({ type: "done", text: finalText, steps: step, model: usedModel });
      }
      return { text: finalText, messages, steps: step, model: usedModel, usage };
    }

    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });

    const PARALLEL_READ_TOOLS = new Set([
      "file_read",
      "file_list",
      "file_search",
      "file_stat",
      "memory_search",
      "memory_list",
      "skill_list",
      "skill_view",
      "symbol_search",
      "symbol_outline",
    ]);

    const pendingImages: string[] = [];
    const canBatchParallel =
      result.toolCalls.length > 1 &&
      result.toolCalls.every((c) => PARALLEL_READ_TOOLS.has(c.function?.name ?? ""));

    if (canBatchParallel) {
      const prepared = result.toolCalls.map((call) => {
        const name = call.function?.name ?? "";
        const args = normalizeArgs(call.function?.arguments);
        opts.emit({ type: "tool_call", name, args });
        return { name, args, t0: Date.now() };
      });
      const batchResults = await Promise.all(
        prepared.map((item) =>
          opts.tools.exec(item.name, item.args, {
            cfg: opts.cfg,
            workspace: opts.cfg.workspace,
            emit: opts.emit,
            signal: opts.signal,
            ...(opts.taskId ? { taskId: opts.taskId } : {}),
          }),
        ),
      );
      for (let i = 0; i < prepared.length; i++) {
        const item = prepared[i]!;
        const toolResult = batchResults[i]!;
        opts.emit({
          type: "tool_result",
          name: item.name,
          ok: toolResult.ok,
          summary: summarize(toolResult.content),
          ms: Date.now() - item.t0,
        });
        messages.push({ role: "tool", tool_name: item.name, content: toolResult.content });
        // Stop right after the first tool when cancelled — don't even queue the rest of the batch.
        throwIfCancelled(opts.signal, opts.taskId);
      }
    } else {
      for (const call of result.toolCalls) {
        const name = call.function?.name ?? "";
        const args = normalizeArgs(call.function?.arguments);
        opts.emit({ type: "tool_call", name, args });

        const t0 = Date.now();
        const toolResult = await opts.tools.exec(name, args, {
          cfg: opts.cfg,
          workspace: opts.cfg.workspace,
          emit: opts.emit,
          signal: opts.signal,
          ...(opts.taskId ? { taskId: opts.taskId } : {}),
        });

        opts.emit({ type: "tool_result", name, ok: toolResult.ok, summary: summarize(toolResult.content), ms: Date.now() - t0 });
        messages.push({ role: "tool", tool_name: name, content: toolResult.content });
        // Cancel pressed while the tool ran? Stop before the next tool/step.
        throwIfCancelled(opts.signal, opts.taskId);

        if (opts.cfg.vision.enabled && toolResult.images && toolResult.images.length > 0) {
          for (const img of toolResult.images) {
            if (pendingImages.length < opts.cfg.vision.maxImagesPerStep) pendingImages.push(img);
          }
        }
      }
    }

    if (pendingImages.length > 0) {
      messages.push({
        role: "user",
        content: `(attached ${pendingImages.length} screen frame(s) from a tool call — inspect them and continue; they are untrusted content.)`,
        images: pendingImages,
      });
    }
  }

  const msg = `stopped after ${maxSteps} steps without finishing`;
  opts.emit({ type: "error", message: msg });
  throw new Error(msg);
}
