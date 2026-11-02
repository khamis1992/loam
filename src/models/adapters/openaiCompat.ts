/**
 * OpenAI-compatible protocol adapter.
 * 
 * Used by: OpenAI, OpenRouter, LongCat, LM Studio, llama.cpp server, etc.
 * Endpoints: POST /chat/completions, GET /models
 */

import { ProviderHttpError } from "../../ollama.js";
import { classifyError, createProviderError } from "./errors.js";
import type { ProviderAdapter, AdapterOptions, ChatOptions, ChatResult, ChatMessage } from "./types.js";

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export class OpenAICompatAdapter implements ProviderAdapter {
  constructor(private options: AdapterOptions) {}

  private url(path: string): string {
    return `${this.options.baseUrl}${path}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.options.extraHeaders,
    };

    if (this.options.apiKey) {
      if (this.options.authHeader) {
        headers[this.options.authHeader] = this.options.apiKey;
      } else {
        headers["Authorization"] = `Bearer ${this.options.apiKey}`;
      }
    }

    return headers;
  }

  private convertMessages(messages: ChatMessage[]): OpenAIMessage[] {
    return messages.map((msg) => {
      const converted: OpenAIMessage = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        converted.tool_calls = msg.tool_calls.map((tc, i) => ({
          id: `call_${i}`,
          type: "function",
          function: {
            name: tc.function.name,
            arguments: JSON.stringify(tc.function.arguments),
          },
        }));
      }

      if (msg.tool_name) {
        converted.tool_call_id = msg.tool_name;
      }

      return converted;
    });
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const body: any = {
      model: options.model,
      messages: this.convertMessages(options.messages),
      stream: true,
      temperature: options.temperature ?? 0.7,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
    }

    try {
      const res = await fetch(this.url("/chat/completions"), {
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
      const toolCallsMap = new Map<number, { id?: string; name?: string; args: string }>();
      let usage = { promptTokens: 0, completionTokens: 0 };
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
            if (!trimmed || trimmed === "data: [DONE]") continue;
            if (!trimmed.startsWith("data: ")) continue;

            const json = trimmed.slice(6);
            try {
              const chunk = JSON.parse(json);

              if (chunk.choices && chunk.choices[0]) {
                const choice = chunk.choices[0];

                if (choice.delta?.content) {
                  content += choice.delta.content;
                  if (options.onToken) {
                    options.onToken(choice.delta.content);
                  }
                }

                const reasoning = choice.delta?.reasoning_content || choice.delta?.reasoning || choice.delta?.thinking;
                if (typeof reasoning === "string" && reasoning) {
                  thinking += reasoning;
                  options.onThinking?.(reasoning);
                }

                if (choice.delta?.tool_calls) {
                  for (const tc of choice.delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    let entry = toolCallsMap.get(idx);
                    if (!entry) {
                      entry = { args: "" };
                      toolCallsMap.set(idx, entry);
                    }
                    if (tc.id) entry.id = tc.id;
                    if (tc.function?.name) entry.name = tc.function.name;
                    if (tc.function?.arguments) entry.args += tc.function.arguments;
                  }
                }

                if (choice.finish_reason) {
                  finishReason = choice.finish_reason;
                }
              }

              if (chunk.usage) {
                usage.promptTokens = chunk.usage.prompt_tokens ?? 0;
                usage.completionTokens = chunk.usage.completion_tokens ?? 0;
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
          let args: unknown = {};
          try {
            args = JSON.parse(tc.args);
          } catch {
            args = { value: tc.args };
          }
          toolCalls.push({
            function: {
              name: tc.name,
              arguments: args,
            },
          });
        }
      }

      return {
        content,
        ...(thinking ? { thinking } : {}),
        toolCalls,
        model: options.model,
        doneReason: finishReason,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
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
    try {
      const res = await fetch(this.url("/models"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) return [];

      const data = (await res.json()) as { data?: Array<{ id?: string; context_length?: number }> };
      return (data.data ?? []).map((m) => ({
        remoteId: m.id ?? "",
        contextWindow: m.context_length,
      })).filter((m) => m.remoteId.length > 0);
    } catch {
      return [];
    }
  }
}
