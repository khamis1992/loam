import { clamp, envValue } from "./util.js";

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return clamp(s, -1, 1);
}

export function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function fromBlob(blob: unknown): Float32Array | null {
  if (blob instanceof Uint8Array) {
    const copy = new Uint8Array(blob.byteLength);
    copy.set(blob);
    return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
  }
  return null;
}

function normalize(vec: number[]): Float32Array {
  const out = Float32Array.from(vec);
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += (out[i] ?? 0) * (out[i] ?? 0);
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}

/** Optional Ollama embeddings. When unset or unreachable the stores fall back
 *  to lexical (FTS5) search only, so the server always works offline. */
export class Embedder {
  private readonly url?: string;
  private readonly model?: string;
  private backoffUntil = 0;

  constructor() {
    this.url = envValue("MEMSKILLS_OLLAMA_URL");
    this.model = envValue("MEMSKILLS_EMBED_MODEL");
  }

  get configured(): boolean {
    return Boolean(this.url && this.model);
  }

  private get usable(): boolean {
    return this.configured && Date.now() >= this.backoffUntil;
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!this.usable) return null;
    const trimmed = text.trim().slice(0, 4000);
    if (trimmed.length === 0) return null;
    try {
      const res = await fetch(`${this.url!.replace(/\/+$/, "")}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: [trimmed] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { embeddings?: number[][] };
        const vec = data.embeddings?.[0];
        if (Array.isArray(vec) && vec.length > 0) return normalize(vec);
      }
    } catch {
      /* fall through */
    }
    try {
      const res = await fetch(`${this.url!.replace(/\/+$/, "")}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: trimmed }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { embedding?: number[] };
        if (Array.isArray(data.embedding) && data.embedding.length > 0) return normalize(data.embedding);
      }
    } catch {
      /* unreachable */
    }
    this.backoffUntil = Date.now() + 60_000;
    return null;
  }
}
