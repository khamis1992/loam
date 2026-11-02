import fs from "node:fs";
import { fromBase64 } from "../embeddings.js";
import type { Embedder, RecallConfig } from "./types.js";
import type { RecallService } from "./service.js";
import { toUnit } from "./vectors.js";

interface LegacyEntry {
  id?: string;
  text?: string;
  kind?: string;
  tags?: string[];
  vector?: string;
  dim?: number;
  createdAt?: string;
}

interface LegacyFile {
  model?: string;
  entries?: LegacyEntry[];
}

const KINDS = new Set(["fact", "preference", "event", "relationship", "insight", "project", "procedure"]);

export async function migrateLegacyStore(service: RecallService, file: string, embedder: Embedder | undefined, config: RecallConfig): Promise<{ imported: number; reused: number }> {
  if (!fs.existsSync(file)) return { imported: 0, reused: 0 };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as LegacyFile;
  const model = parsed.model ?? "";
  let imported = 0;
  let reused = 0;
  for (const entry of parsed.entries ?? []) {
    if (!entry.text || !entry.text.trim()) continue;
    const kind = KINDS.has(entry.kind ?? "") ? entry.kind as "fact" : "fact";
    let embedding: Float32Array | undefined;
    if (entry.vector && entry.dim && model === config.models.embedder) {
      embedding = toUnit(fromBase64(entry.vector, entry.dim));
      reused += 1;
    } else if (embedder) {
      const [vec] = await embedder.embed([entry.text]);
      if (vec) embedding = toUnit(vec);
    }
    await service.remember({
      content: entry.text,
      scope: "user",
      kind,
      origin: "assistant",
      confidence: 0.6,
      tags: entry.tags ?? [],
      ...(embedding ? { embedding } : {}),
    });
    imported += 1;
  }
  const backup = `${file}.bak`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  return { imported, reused };
}
