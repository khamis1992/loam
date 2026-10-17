export class OllamaEmbedder {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  private url(p: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${p}`;
  }

  /** Embed a batch of texts. Tries /api/embed (batch) then falls back to /api/embeddings. */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
      const res = await fetch(this.url("/api/embed"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { embeddings?: number[][] };
        if (Array.isArray(data.embeddings) && data.embeddings.length === texts.length) {
          return data.embeddings;
        }
      }
    } catch {
      /* fall through to legacy endpoint */
    }
    const out: number[][] = [];
    for (const text of texts) {
      const res = await fetch(this.url("/api/embeddings"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`ollama /api/embeddings HTTP ${res.status}`);
      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
        throw new Error("ollama returned no embedding");
      }
      out.push(data.embedding);
    }
    return out;
  }

  async embedOne(text: string): Promise<number[]> {
    const [v] = await this.embed([text]);
    if (!v) throw new Error("empty embedding");
    return v;
  }
}

export function toBase64(vec: number[] | Float32Array): string {
  const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("base64");
}

export function fromBase64(b64: string, dim: number): Float32Array {
  const buf = Buffer.from(b64, "base64");
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  const f = new Float32Array(copy.buffer, 0, Math.min(dim, copy.byteLength / 4));
  return f;
}

export function normalize(vec: number[] | Float32Array): Float32Array {
  const out = vec instanceof Float32Array ? Float32Array.from(vec) : Float32Array.from(vec);
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += (out[i] ?? 0) * (out[i] ?? 0);
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  }
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
