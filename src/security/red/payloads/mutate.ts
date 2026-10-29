/**
 * Smart payload mutation (Supremacy M5.3): the model generates context-aware
 * WAF-bypass variants of a base payload.
 */
import type { OllamaClient } from "../../../ollama.js";
import type { Payload } from "../payloads/payloads.js";

export interface MutatedPayload {
  original: string;
  variant: string;
  technique: string;
}

const MUTATE_PROMPT = (base: string, context: string) => `You are a WAF-bypass payload generator. Given a base payload and app context, generate 5 alternative variants that achieve the same effect but evade the described filter. Output ONLY a JSON array of objects: [{variant: string, technique: string}]. No explanation.

Base payload: ${base}
App context / filter: ${context}`;

export async function mutatePayload(
  payload: Payload,
  context: { waf?: string; filter?: string },
  model: { chat: OllamaClient["chat"] },
): Promise<MutatedPayload[]> {
  if (!payload.template) return [];
  const ctx = [context.waf ? `WAF: ${context.waf}` : "", context.filter ? `Filter: ${context.filter}` : ""].filter(Boolean).join("; ") || "generic web filter";
  const result = await model.chat({
    model: "loam",
    messages: [{ role: "user", content: MUTATE_PROMPT(payload.template, ctx) }],
    temperature: 0.3,
    timeoutMs: 60_000,
  });
  try {
    const text = result.content.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    const parsed = JSON.parse(text) as Array<{ variant?: string; technique?: string }>;
    return parsed
      .filter((p) => typeof p.variant === "string" && p.variant.length > 0 && p.variant.length < 1000)
      .slice(0, 5)
      .map((p) => ({ original: payload.template, variant: p.variant!, technique: p.technique ?? "unknown" }));
  } catch {
    return [];
  }
}
