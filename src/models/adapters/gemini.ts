/**
 * Google Gemini protocol adapter.
 * 
 * Native Generative AI API (not OpenAI-compatible).
 * Endpoints: POST /v1beta/models/{model}:streamGenerateContent?alt=sse, GET /v1beta/models
 * Auth: x-goog-api-key header (not Bearer)
 * Model ID: "models/gemini-1.5-pro" or "gemini-1.5-pro" (adapter strips "models/" prefix)
 */

import { ProviderHttpError } from "../../ollama.js";
import { classifyError, createProviderError } from "./errors.js";
import type { ProviderAdapter, AdapterOptions, ChatOptions, ChatResult, ChatMessage } from "./types.js";

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text?: string; functionCall?: { name: string; args: unknown }; functionResponse?: { name: string; response: unknown } }>;
}

export class GeminiAdapter implements ProviderAdapter {
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
      headers["x-goog-api-key"] = this.options.apiKey;
    }

    return headers;
  }

  private normalizeModelId(model: string): string {
    // Strip "models/" prefix if present
    return model.replace(/^models\//, "");
  }

  private convertMessages(messages: ChatMessage[]): { systemInstruction?: { parts: Array<{ text: string }> }; contents: GeminiContent[] } {
    let systemInstruction: { parts: Array<{ text: string }> } | undefined;
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemInstruction = { parts: [{ text: msg.content }] };
        continue;
      }

      if (msg.role === "tool") {
        // Tool results as functionResponse
        contents.push({
          role: "model",
          parts: [
            {
              functionResponse: {
                name: msg.tool_name || "unknown",
                response: { result: msg.content },
              },
            },
          ],
        });
        continue;
      }

      const geminiContent: GeminiContent = {
        role: msg.role === "user" ? "user" : "model",
        parts: [],
      };

      if (msg.content) {
        geminiContent.parts.push({ text: msg.content });
      }

      // Tool calls as functionCall
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          geminiContent.parts.push({
            functionCall: {
              name: tc.function.name,
              args: tc.function.arguments,
            },
          });
        }
      }

      contents.push(geminiContent);
    }

    return { systemInstruction, contents };
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const { systemInstruction, contents } = this.convertMessages(options.messages);
    const modelId = this.normalizeModelId(options.model);

    const body: any = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.numPredict ?? 8192,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: options.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          })),
        },
      ];
    }

    try {
      const res = await fetch(this.url(`/models/${modelId}:streamGenerateContent?alt=sse`), {
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
      const toolCalls: any[] = [];
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
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const json = trimmed.slice(6);
            try {
              const chunk = JSON.parse(json);

              if (chunk.candidates && chunk.candidates[0]) {
                const candidate = chunk.candidates[0];

                if (candidate.content?.parts) {
                  for (const part of candidate.content.parts) {
                    if (part.text) {
                      content += part.text;
                      if (options.onToken) {
                        options.onToken(part.text);
                      }
                    }

                    if (part.functionCall) {
                      toolCalls.push({
                        function: {
                          name: part.functionCall.name,
                          arguments: part.functionCall.args || {},
                        },
                      });
                    }
                  }
                }

                if (candidate.finishReason) {
                  finishReason = candidate.finishReason;
                }
              }

              if (chunk.usageMetadata) {
                usage.promptTokens = chunk.usageMetadata.promptTokenCount ?? 0;
                usage.completionTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
              }
            } catch (e) {
              // Skip malformed chunks
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      return {
        content,
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
    const res = await fetch(this.url("/models?pageSize=1000"), {
      headers: this.headers(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new ProviderHttpError(`HTTP ${res.status}`, res.status, res.headers);
    const data = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => ({
        remoteId: this.normalizeModelId(m.name ?? ""),
      }))
      .filter((m) => m.remoteId.length > 0);
  }
}
