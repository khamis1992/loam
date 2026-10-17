import { log } from "./log.js";

export interface OllamaFunctionTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OllamaToolCall {
  function: { name: string; arguments: unknown };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  images?: string[];
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: OllamaFunctionTool[];
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
}

export interface ChatResult {
  content: string;
  toolCalls: OllamaToolCall[];
  model: string;
  doneReason?: string;
  usage: { promptTokens: number; completionTokens: number; durationMs: number };
}

interface OllamaStreamChunk {
  model?: string;
  message?: { role?: string; content?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

function normalizeArgs(v: unknown): unknown {
  if (typeof v === "string") {
    const s = v.trim();
    if (s.length === 0) return {};
    try {
      return JSON.parse(s);
    } catch {
      return { value: v };
    }
  }
  return v ?? {};
}

export class OllamaClient {
  constructor(private readonly baseUrl: string) {}

  private url(p: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${p}`;
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(this.url("/api/tags"));
    if (!res.ok) throw new Error(`ollama /api/tags HTTP ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => m.name ?? "").filter((n) => n.length > 0);
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const body = {
      model: opts.model,
      stream: true,
      messages: opts.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_name ? { tool_name: m.tool_name } : {}),
        ...(m.images ? { images: m.images } : {}),
      })),
      ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      options: { temperature: opts.temperature ?? 0.2 },
    };

    const signals: AbortSignal[] = [];
    if (opts.signal) signals.push(opts.signal);
    signals.push(AbortSignal.timeout(opts.timeoutMs ?? 600_000));
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

    const res = await fetch(this.url("/api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ollama /api/chat HTTP ${res.status}${text ? `: ${text.slice(0, 800)}` : ""}`);
    }
    if (!res.body) throw new Error("ollama returned empty body");

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let toolCalls: OllamaToolCall[] = [];
    let model = opts.model;
    let doneReason: string | undefined;
    let promptTokens = 0;
    let completionTokens = 0;
    let durationMs = 0;

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let parsed: OllamaStreamChunk;
        try {
          parsed = JSON.parse(line) as OllamaStreamChunk;
        } catch {
          continue;
        }
        if (parsed.error) throw new Error(`ollama error: ${parsed.error}`);
        if (parsed.model) model = parsed.model;
        const msg = parsed.message;
        if (msg?.content) {
          content += msg.content;
          opts.onToken?.(msg.content);
        }
        if (msg?.tool_calls && msg.tool_calls.length > 0) {
          toolCalls = msg.tool_calls.map((c) => ({ function: { name: c.function?.name ?? "", arguments: normalizeArgs(c.function?.arguments) } }));
        }
        if (parsed.done) {
          doneReason = parsed.done_reason;
          promptTokens = parsed.prompt_eval_count ?? promptTokens;
          completionTokens = parsed.eval_count ?? completionTokens;
          const computeNs = (parsed.prompt_eval_duration ?? 0) + (parsed.eval_duration ?? 0);
          durationMs = Math.round((computeNs > 0 ? computeNs : parsed.total_duration ?? 0) / 1e6);
        }
      }
    }

    log.debug(`ollama chat model=${model} tools=${toolCalls.length} chars=${content.length}`);
    return { content, toolCalls, model, doneReason, usage: { promptTokens, completionTokens, durationMs } };
  }
}
