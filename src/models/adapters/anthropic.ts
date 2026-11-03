/**
 * Anthropic protocol adapter.
 * 
 * Native Anthropic Messages API (not OpenAI-compatible).
 * Endpoints: POST /v1/messages, GET /v1/models
 * Auth: x-api-key header (not Bearer)
 * SSE events: message_start, content_block_delta, message_delta, etc.
 */

import { ProviderHttpError } from "../../ollama.js";
import { classifyError, createProviderError } from "./errors.js";
import type { ProviderAdapter, AdapterOptions, ChatOptions, ChatResult, ChatMessage } from "./types.js";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; tool_use_id?: string; content?: string; id?: string; name?: string; input?: unknown }>;
}

export class AnthropicAdapter implements ProviderAdapter {
  constructor(private options: AdapterOptions) {}

  private url(path: string): string {
    return `${this.options.baseUrl}${path}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...this.options.extraHeaders,
    };

    if (this.options.apiKey) {
      headers["x-api-key"] = this.options.apiKey;
    }

    return headers;
  }

  private convertMessages(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
    let system: string | undefined;
    const converted: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        system = msg.content;
        continue;
      }

      if (msg.role === "tool") {
        // Tool results go as content blocks in user message
        converted.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_name || "unknown",
              content: msg.content,
            },
          ],
        });
        continue;
      }

      const anthropicMsg: AnthropicMessage = {
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content,
      };

      // Tool calls become content blocks
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const blocks: any[] = [];
        if (msg.content) {
          blocks.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          blocks.push({
            type: "tool_use",
            id: `toolu_${Date.now()}`,
            name: tc.function.name,
            input: tc.function.arguments,
          });
        }
        anthropicMsg.content = blocks;
      }

      converted.push(anthropicMsg);
    }

    return { system, messages: converted };
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const { system, messages } = this.convertMessages(options.messages);

    const body: any = {
      model: options.model,
      messages,
      max_tokens: options.numPredict ?? 8192,
      stream: true,
      temperature: options.temperature ?? 0.7,
    };

    if (system) {
      body.system = system;
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    try {
      const res = await fetch(this.url("/messages"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: this.options.signal ?? AbortSignal.timeout(this.options.timeoutMs),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let errorBody: unknown;
        try {
          errorBody = JSON.parse(text);
        } catch {
          errorBody = { message: text };
        }
        const adapterError = createProviderError(res.status, errorBody, undefined);
        throw new ProviderHttpError(adapterError.message, res.status, res.headers);
      }

      if (!res.body) {
        throw new Error("No response body for streaming");
      }

      // Parse SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let thinking = "";
      const toolCalls: any[] = [];
      const toolCallsMap = new Map<string, { name?: string; input: string }>();
      let usage = { inputTokens: 0, outputTokens: 0 };
      let finishReason = "";
      const startTime = Date.now();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const json = trimmed.slice(6);
            try {
              const event = JSON.parse(json);

              if (event.type === "content_block_delta") {
                if (event.delta?.type === "text_delta" && event.delta.text) {
                  content += event.delta.text;
                  if (options.onToken) {
                    options.onToken(event.delta.text);
                  }
                }

                if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
                  thinking += event.delta.thinking;
                  if (options.onThinking) {
                    options.onThinking(event.delta.thinking);
                  }
                }

                if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
                  const idx = event.index ?? 0;
                  const id = `tool_${idx}`;
                  let entry = toolCallsMap.get(id);
                  if (!entry) {
                    entry = { input: "" };
                    toolCallsMap.set(id, entry);
                  }
                  entry.input += event.delta.partial_json;
                }
              }

              if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
                const block = event.content_block;
                const id = block.id || `tool_${event.index ?? 0}`;
                toolCallsMap.set(id, { name: block.name, input: "" });
              }

              if (event.type === "message_delta") {
                if (event.delta?.stop_reason) {
                  finishReason = event.delta.stop_reason;
                }
                if (event.usage) {
                  usage.outputTokens = event.usage.output_tokens ?? 0;
                }
              }

              if (event.type === "message_start" && event.message?.usage) {
                usage.inputTokens = event.message.usage.input_tokens ?? 0;
              }
            } catch (e) {
              // Skip malformed chunks
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Convert tool calls
      for (const [_, tc] of toolCallsMap) {
        if (tc.name) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.input);
          } catch {
            input = { value: tc.input };
          }
          toolCalls.push({
            function: {
              name: tc.name,
              arguments: input,
            },
          });
        }
      }

      return {
        content,
        thinking,
        toolCalls,
        model: options.model,
        doneReason: finishReason,
        usage: {
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      if (error instanceof ProviderHttpError) throw error;
      const adapterError = classifyError(error);
      throw new ProviderHttpError(adapterError.message, adapterError.status ?? 0);
    }
  }

  async listModels() {
    const res = await fetch(this.url("/models"), {
      headers: this.headers(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new ProviderHttpError(`HTTP ${res.status}`, res.status, res.headers);
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? [])
      .map((m) => ({ remoteId: m.id ?? "" }))
      .filter((m) => m.remoteId.length > 0);
  }
}
