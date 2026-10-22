import { log } from "./log.js";

/** Transport ended without a model completion marker. Partial output is never usable. */
export class IncompleteModelStream extends Error {
  constructor(provider: "cloud" | "ollama") {
    super(`${provider} stream ended before completion; partial output is unverified`);
    this.name = "IncompleteModelStream";
  }
}

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
  /** Optional constrained JSON output for local models. */
  format?: Record<string, unknown>;
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

export interface CloudModelConfig {
  baseUrl: string;
  apiKey?: string;
}

interface OpenAIStreamChunk {
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OllamaClient {
  constructor(private readonly baseUrl: string, private readonly cloud?: CloudModelConfig) {}

  private url(p: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${p}`;
  }

  async listModels(): Promise<string[]> {
    const local = await this.listLocalModels();
    const cloud = this.cloud ? await this.listCloudModels().catch(() => [] as string[]) : [];
    return [...local, ...cloud.filter((c) => !local.includes(c))];
  }

  private async listLocalModels(): Promise<string[]> {
    const res = await fetch(this.url("/api/tags"));
    if (!res.ok) throw new Error(`ollama /api/tags HTTP ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => m.name ?? "").filter((n) => n.length > 0);
  }

  private async listCloudModels(): Promise<string[]> {
    if (!this.hasCloudKey()) return [];
    const res = await fetch(`${this.cloud!.baseUrl.replace(/\/+$/, "")}/models`, { headers: this.cloudHeaders(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`cloud /models HTTP ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => (m.id ?? "").trim()).filter((id) => id.length > 0).map((id) => `${id}:cloud`);
  }

  private cloudHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = typeof this.cloud?.apiKey === "string" ? this.cloud.apiKey.trim() : "";
    if (key.length > 0) {
      // HTTP header values must be printable ASCII; strip anything outside that range
      // to avoid Node's "Cannot convert argument to a ByteString" error on non-Latin-1 characters.
      const safeKey = key.replace(/[^\x20-\x7E]/g, "");
      if (safeKey.length > 0) headers.authorization = `Bearer ${safeKey}`;
    }
    return headers;
  }

  private hasCloudKey(): boolean {
    return typeof this.cloud?.apiKey === "string" && this.cloud.apiKey.trim().length > 0;
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    // ":cloud" routes to the configured OpenAI-compatible provider only; without one the
    // local endpoint keeps serving the full name unchanged (existing proxy setups).
    if (opts.model.endsWith(":cloud") && this.cloud) return this.chatCloud(opts);
    return this.chatLocal(opts);
  }

  /** OpenAI-compatible chat completions (OpenRouter and friends) with Ollama-style streaming and tool calls. */
  private async chatCloud(opts: ChatOptions): Promise<ChatResult> {
    if (!this.hasCloudKey()) {
      throw new Error(
        "No cloud API key configured. Add cloudModel.apiKey to config.json to use cloud models."
      );
    }
    const stripped = opts.model.slice(0, -":cloud".length);
    // OpenAI needs tool_call ids; assign them in order and match following tool messages by name/index.
    const pendingIds: string[] = [];
    const messages = opts.messages.map((m, index) => {
      if (m.role === "assistant" && m.tool_calls?.length) {
        pendingIds.length = 0;
        return {
          role: "assistant" as const,
          content: m.content || null,
          tool_calls: m.tool_calls.map((call, i) => {
            const id = `loam_${index}_${i}`;
            pendingIds.push(id);
            return { id, type: "function" as const, function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments ?? {}) } };
          }),
        };
      }
      if (m.role === "tool") {
        const id = pendingIds.shift() ?? `loam_tool_${index}`;
        return { role: "tool" as const, tool_call_id: id, content: m.content };
      }
      if (m.images?.length) {
        return {
          role: m.role,
          content: [
            { type: "text", text: m.content },
            ...m.images.map((image) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${image}` } })),
          ],
        };
      }
      return { role: m.role, content: m.content };
    });
    const body = {
      model: stripped,
      stream: true,
      stream_options: { include_usage: true },
      messages,
      ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      temperature: opts.temperature ?? 0.2,
    };

    const signals: AbortSignal[] = [];
    if (opts.signal) signals.push(opts.signal);
    signals.push(AbortSignal.timeout(opts.timeoutMs ?? 600_000));
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

    const res = await fetch(`${this.cloud!.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: this.cloudHeaders(),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`cloud /chat/completions HTTP ${res.status}${text ? `: ${text.slice(0, 800)}` : ""}`);
    }
    if (!res.body) throw new Error("cloud provider returned empty body");

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let model = opts.model;
    let doneReason: string | undefined;
    let promptTokens = 0;
    let completionTokens = 0;
    const started = Date.now();
    let sawFinish = false;

    const consume = (data: string) => {
      if (data === "[DONE]") return;
      let parsed: OpenAIStreamChunk;
      try {
        parsed = JSON.parse(data) as OpenAIStreamChunk;
      } catch {
        throw new Error("cloud stream contained malformed JSON");
      }
      if (parsed.error) throw new Error(`cloud error: ${parsed.error.message ?? "unknown"}`);
      if (parsed.model) model = `${parsed.model}:cloud`;
      const choice = parsed.choices?.[0];
      if (choice?.delta?.content) {
        content += choice.delta.content;
        opts.onToken?.(choice.delta.content);
      }
      for (const call of choice?.delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = toolAcc.get(index) ?? { id: call.id ?? `loam_call_${index}`, name: "", args: "" };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.args += call.function.arguments;
        toolAcc.set(index, current);
      }
      if (choice?.finish_reason) {
        sawFinish = true;
        doneReason = choice.finish_reason;
      }
      if (parsed.usage) {
        promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
        completionTokens = parsed.usage.completion_tokens ?? completionTokens;
      }
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) consume(line.slice(5).trim());
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().startsWith("data:")) consume(buffer.trim().slice(5).trim());
    if (!sawFinish) throw new IncompleteModelStream("cloud");
    const toolCalls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => ({ function: { name: call.name, arguments: normalizeArgs(call.args) } }));
    log.debug(`cloud chat model=${model} tools=${toolCalls.length} chars=${content.length}`);
    return { content, toolCalls, model, doneReason, usage: { promptTokens, completionTokens, durationMs: Date.now() - started } };
  }

  private async chatLocal(opts: ChatOptions): Promise<ChatResult> {
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
      ...(opts.format ? { format: opts.format } : {}),
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
    let sawDone = false;

    const consumeLine = (line: string) => {
        if (!line.trim()) return;
        if (sawDone) throw new Error("ollama stream contained data after completion");
        let parsed: OllamaStreamChunk;
        try {
          parsed = JSON.parse(line) as OllamaStreamChunk;
        } catch {
          throw new Error("ollama stream contained malformed JSON");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ollama stream contained an invalid chunk");
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
        if (parsed.done === true) {
          sawDone = true;
          doneReason = parsed.done_reason;
          promptTokens = parsed.prompt_eval_count ?? promptTokens;
          completionTokens = parsed.eval_count ?? completionTokens;
          const computeNs = (parsed.prompt_eval_duration ?? 0) + (parsed.eval_duration ?? 0);
          durationMs = Math.round((computeNs > 0 ? computeNs : parsed.total_duration ?? 0) / 1e6);
        }
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        consumeLine(line);
      }
    }
    buffer += decoder.decode();
    consumeLine(buffer);
    if (!sawDone) throw new IncompleteModelStream("ollama");

    log.debug(`ollama chat model=${model} tools=${toolCalls.length} chars=${content.length}`);
    return { content, toolCalls, model, doneReason, usage: { promptTokens, completionTokens, durationMs } };
  }
}
