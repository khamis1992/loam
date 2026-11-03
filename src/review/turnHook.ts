import type { OllamaClient } from "../ollama.js";
import { adjustForeground } from "../memory/recall/idle.js";
import { getRecallService } from "../memory/recall/instance.js";
import { projectScope } from "../memory/recall/vectors.js";
import type { TextModel } from "../memory/recall/types.js";
import { pathFromTool } from "./changedFiles.js";
import { DEFAULT_REVIEW_POLICY, harnessNote, secondLook, type ReviewPolicy } from "./secondLook.js";

let policy: ReviewPolicy = DEFAULT_REVIEW_POLICY;
let currentMode = "ask";
let boundModel: TextModel | undefined;

export function configureTurnHooks(next: { policy?: ReviewPolicy; mode?: string; model?: TextModel }): void {
  if (next.policy) policy = next.policy;
  if (next.mode) currentMode = next.mode;
  if (next.model) boundModel = next.model;
}

export function textModelFromOllama(ollama: OllamaClient, model: string): TextModel {
  return {
    async complete(system, user, opts) {
      const result = await ollama.chat({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: opts.temperature,
        timeoutMs: opts.timeoutMs,
        think: false,
        ...(opts.format ? { format: opts.format } : {}),
        ...(opts.numCtx ? { numCtx: opts.numCtx } : {}),
      });
      return { text: result.content, promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens };
    },
  };
}

export function beginForeground(): void {
  adjustForeground(1);
}

export function endForeground(): void {
  adjustForeground(-1);
}

export function noteTouchedPath(name: string, args: unknown, ledger: string[]): void {
  const file = pathFromTool(name, args);
  if (file) ledger.push(file);
}

export async function recallSystemBlock(prompt: string, workspace: string, nested: boolean, mode = currentMode): Promise<string> {
  if (nested) return "";
  const service = getRecallService();
  if (!service) return "";
  try {
    return await service.injection(prompt, projectScope(workspace), mode === "legal");
  } catch {
    return "";
  }
}

function activePolicy(): ReviewPolicy {
  const raw = getRecallService()?.repo.getSetting("reviewModes");
  if (!raw) return policy;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return policy;
  }
  if (!parsed || typeof parsed !== "object") return policy;
  const modes = { ...policy.modes };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === "off" || value === "read" || value === "run") modes[key] = value;
  }
  return { ...policy, modes };
}

export async function maybeSecondLook(input: {
  runId: string;
  workspace: string;
  requests: string[];
  reply: string;
  turnStartedAt: number;
  touched: string[];
  toolCalls: number;
  depth: number;
  aborted: boolean;
  alreadyReviewed: boolean;
  ollama: OllamaClient;
  modelName: string;
  mode?: string;
}): Promise<string | null> {
  const model = boundModel ?? textModelFromOllama(input.ollama, input.modelName);
  try {
    const outcome = await secondLook({ ...input, mode: input.mode ?? currentMode }, model, activePolicy(), getRecallService()?.repo.db);
    if (outcome.status !== "findings") return null;
    return harnessNote(outcome.findings);
  } catch {
    return null;
  }
}

export function queueTurnIngest(sessionId: string, workspace: string, userText: string, assistantText: string, nested: boolean): void {
  if (nested) return;
  const service = getRecallService();
  if (!service) return;
  try {
    service.ingestTurn({ sessionId, scope: projectScope(workspace), userText, assistantText });
  } catch { /* ingest must never fail the turn */ }
}

export function reviewPolicy(): ReviewPolicy {
  return policy;
}
