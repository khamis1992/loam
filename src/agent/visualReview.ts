import type { ChatOptions, ChatResult, OllamaClient } from "../ollama.js";
import { IncompleteModelStream } from "../ollama.js";

export class VisualReviewUnavailable extends Error {
  constructor(message: string, public attempts: number) { super(message); this.name = "VisualReviewUnavailable"; }
}

/** Retry only transient transport failures, using exactly the same screenshots
 * and model. A semantic rejection or malformed verdict is never retried here. */
export async function visualReview(ollama: OllamaClient, options: ChatOptions): Promise<{ result: ChatResult; attempts: number }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      options.signal?.throwIfAborted();
      return { result: await ollama.chat(options), attempts: attempt };
    } catch (e) {
      const detail = String(e);
      const transient = e instanceof IncompleteModelStream || /timeout|timed out|HTTP (?:429|5\d\d)|ECONNRESET|fetch failed|network/i.test(detail);
      if (options.signal?.aborted || !transient || attempt === 2) throw new VisualReviewUnavailable(`Visual review unavailable after ${attempt} attempt(s): ${detail}`, attempt);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error("Unreachable visual review state");
}
