import { findSecret, stripSecrets } from "../redact.js";
import { classifyLink } from "./extract.js";
import { detectLang, tokenize, tokenJaccard } from "./normalize.js";
import type { RecallRepo } from "./repo.js";
import type { Embedder, MemoryRecord, RecallConfig, RememberInput, RememberResult, TextModel } from "./types.js";
import { contentHash, cosine, newId, toUnit } from "./vectors.js";
import { LshIndex } from "./lsh.js";

export function redactFact(content: string): string | null {
  const stripped = stripSecrets(content).trim();
  if (!stripped || stripped === "[redacted]") return null;
  if (findSecret(stripped)) return null;
  return stripped;
}

export async function rememberFact(
  repo: RecallRepo,
  config: RecallConfig,
  embedder: Embedder | undefined,
  model: TextModel | undefined,
  input: RememberInput,
  now = Date.now(),
): Promise<RememberResult> {
  const content = redactFact(input.content);
  if (!content) throw new Error("memory rejected");
  const hash = contentHash(input.scope, content);
  const existingHash = repo.findByHash(input.scope, hash);
  if (existingHash) return confirmOrTouch(repo, existingHash, input.origin, now);

  const embedding = input.embedding ?? (embedder ? toUnit((await embedder.embed([content]))[0] ?? []) : undefined);
  const modelId = embedding ? `${config.models.embedder}@${embedding.length}` : undefined;
  const latest = repo.latest([input.scope], ["active", "dormant"]);
  const tokens = tokenize(content);
  for (const memory of latest) {
    const jac = tokenJaccard(tokens, tokenize(memory.content));
    const cos = embedding && memory.embedding ? cosine(embedding, memory.embedding) : 0;
    const duplicate = (jac >= config.dedupe.jaccard && cos >= config.dedupe.cosineWithJaccard) || cos >= config.dedupe.cosineAlone;
    if (duplicate) return confirmOrTouch(repo, memory, input.origin, now);
  }

  const ranked = latest
    .map((memory) => ({ memory, cos: embedding && memory.embedding ? cosine(embedding, memory.embedding) : 0 }))
    .filter((row) => row.cos >= config.link.extendCos)
    .sort((a, b) => b.cos - a.cos)
    .slice(0, config.link.topK);
  const label = model ? await classifyLink(model, content, ranked.map((row) => row.memory.content)) : "NEW";
  const target = ranked[0];
  const id = newId("mem_");
  const record: MemoryRecord = {
    id,
    scope: input.scope,
    content,
    lang: detectLang(content),
    kind: input.kind ?? "fact",
    origin: input.origin,
    importance: input.importance ?? 5,
    confidence: input.confidence ?? 0.8,
    prominence: 1,
    state: "active",
    isLatest: true,
    pinned: input.pinned ?? false,
    confirmations: input.origin === "user" ? 1 : 0,
    accessCount: 0,
    ...(input.eventAt !== undefined ? { eventAt: input.eventAt } : {}),
    documentAt: now,
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    tags: input.tags ?? [],
    ...(modelId ? { embeddingModel: modelId } : {}),
    ...(embedding && embedding.length > 0 ? { embedding } : {}),
    contentHash: hash,
    createdAt: now,
    updatedAt: now,
  };

  if (label === "UPDATES" && target && target.cos >= config.link.updateCos) {
    repo.transaction(() => {
      repo.update({ ...target.memory, isLatest: false, state: "superseded", decayRate: 0.9, updatedAt: now });
      repo.event(target.memory.id, "supersede", { by: id });
      repo.insert(record);
      repo.addRelation({ id: newId("rel_"), fromId: id, toId: target.memory.id, type: "UPDATES", confidence: target.cos, origin: "ingest", createdAt: now });
      writeLsh(repo, config, record);
    });
    return { id, action: "updated" };
  }
  if (label === "EXTENDS" && target) {
    repo.transaction(() => {
      repo.insert(record);
      repo.addRelation({ id: newId("rel_"), fromId: id, toId: target.memory.id, type: "EXTENDS", confidence: target.cos, origin: "ingest", createdAt: now });
      writeLsh(repo, config, record);
    });
    return { id, action: "extended" };
  }
  repo.transaction(() => {
    repo.insert(record);
    writeLsh(repo, config, record);
  });
  return { id, action: "inserted" };
}

function confirmOrTouch(repo: RecallRepo, memory: MemoryRecord, origin: RememberInput["origin"], now: number): RememberResult {
  if (origin === "user") repo.confirm(memory.id, now);
  else repo.update({ ...memory, updatedAt: now });
  return { id: memory.id, action: "confirmed" };
}

function writeLsh(repo: RecallRepo, config: RecallConfig, memory: MemoryRecord): void {
  if (!memory.embedding || repo.countLatest() < config.lsh.bruteForceBelow) return;
  const index = new LshIndex(memory.embedding.length, config.lsh);
  repo.replaceLsh(memory.id, memory.scope, config.models.embedder, index.signature(memory.embedding));
}
