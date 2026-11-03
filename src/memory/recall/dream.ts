import type { MemoryRecord, RecallConfig, TextModel } from "./types.js";
import type { RecallRepo } from "./repo.js";
import { cosine } from "./vectors.js";
import { newId } from "./vectors.js";
import { contentHash } from "./vectors.js";
import { detectLang } from "./normalize.js";

export interface DreamDeps {
  repo: RecallRepo;
  config: RecallConfig;
  model?: TextModel;
  now?: number;
}

export async function nremFuse(deps: DreamDeps): Promise<{ clusters: number }> {
  const now = deps.now ?? Date.now();
  const rows = deps.repo.latest(undefined, ["active", "dormant"]).filter((memory) => {
    return memory.prominence >= 0.05 && memory.prominence < 0.8 && memory.embedding;
  });
  const used = new Set<string>();
  let clusters = 0;
  for (const seed of rows) {
    if (clusters >= 10 || used.has(seed.id) || !seed.embedding) continue;
    const group = [seed];
    for (const other of rows) {
      if (other.id === seed.id || other.scope !== seed.scope || !other.embedding || used.has(other.id)) continue;
      if (cosine(seed.embedding, other.embedding) >= 0.7) group.push(other);
    }
    if (group.length < 2) continue;
    used.add(seed.id);
    for (const member of group) used.add(member.id);
    const fused = await fuseText(deps.model, group);
    const id = newId("mem_");
    const memory: MemoryRecord = {
      id,
      scope: seed.scope,
      content: fused,
      lang: detectLang(fused),
      kind: "insight",
      origin: "fusion",
      importance: 5,
      confidence: 0.7,
      prominence: 0.8,
      state: "active",
      isLatest: true,
      pinned: false,
      confirmations: 0,
      accessCount: 0,
      documentAt: now,
      tags: ["nrem"],
      contentHash: contentHash(seed.scope, fused),
      createdAt: now,
      updatedAt: now,
    };
    deps.repo.insert(memory);
    for (const member of group) {
      deps.repo.update({ ...member, state: "dormant", updatedAt: now });
      deps.repo.event(member.id, "dormant", { fused: id });
      deps.repo.addRelation({ id: newId("rel_"), fromId: id, toId: member.id, type: "DERIVES", confidence: 0.8, origin: "nrem", createdAt: now });
    }
    deps.repo.event(id, "fuse", { sources: group.map((member) => member.id) });
    clusters += 1;
  }
  return { clusters };
}

async function fuseText(model: TextModel | undefined, group: MemoryRecord[]): Promise<string> {
  const source = group.map((memory) => memory.content).join(" ");
  if (!model) return source.slice(0, 500);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await model.complete(
        "Fuse these memories into one self-contained statement. Reply with JSON {\"content\":string}.",
        group.map((memory) => memory.content).join("\n"),
        { temperature: 0.1, timeoutMs: 20_000, format: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
      );
      const match = result.text.match(/\{[\s\S]*\}/);
      if (!match) continue;
      const parsed = JSON.parse(match[0]) as { content?: string };
      if (parsed.content && parsed.content.trim()) return parsed.content.trim();
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  return source.slice(0, 500);
}

export async function remAssociate(deps: DreamDeps): Promise<{ edges: number }> {
  const now = deps.now ?? Date.now();
  const rows = deps.repo.latest(undefined, ["active", "dormant"]);
  const byKind = new Map<string, MemoryRecord[]>();
  for (const memory of rows) {
    const list = byKind.get(memory.kind) ?? [];
    if (list.length < 2) list.push(memory);
    byKind.set(memory.kind, list);
  }
  const seeds = [...byKind.values()].flat().slice(0, 6);
  let edges = 0;
  for (const seed of seeds) {
    const pairs = rows.filter((memory) => memory.id !== seed.id && memory.scope === seed.scope).slice(0, 4);
    if (pairs.length === 0) continue;
    const judged = await judgePairs(deps.model, seed, pairs);
    for (const edge of judged) {
      if (edge.confidence < 0.7) continue;
      deps.repo.addRelation({
        id: newId("rel_"),
        fromId: seed.id,
        toId: edge.toId,
        type: edge.type,
        confidence: edge.confidence,
        origin: "rem",
        createdAt: now,
      });
      edges += 1;
    }
  }
  return { edges };
}

async function judgePairs(model: TextModel | undefined, seed: MemoryRecord, pairs: MemoryRecord[]): Promise<Array<{ toId: string; type: "RELATES" | "EXTENDS"; confidence: number }>> {
  if (!model) return [];
  const result = await model.complete(
    "Judge which pairs deserve a RELATES or EXTENDS edge. Reply with JSON {\"edges\":[{\"index\":number,\"type\":\"RELATES\"|\"EXTENDS\",\"confidence\":number}]}. Drop anything below 0.7.",
    `Seed:\n${seed.content}\n\nPairs:\n${pairs.map((memory, index) => `${index}. ${memory.content}`).join("\n")}`,
    { temperature: 0.2, timeoutMs: 20_000 },
  );
  const match = result.text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { edges?: Array<{ index?: number; type?: string; confidence?: number }> };
    const out: Array<{ toId: string; type: "RELATES" | "EXTENDS"; confidence: number }> = [];
    for (const edge of parsed.edges ?? []) {
      if (typeof edge.index !== "number" || !pairs[edge.index]) continue;
      const type = edge.type === "EXTENDS" ? "EXTENDS" : "RELATES";
      const confidence = typeof edge.confidence === "number" ? edge.confidence : 0;
      out.push({ toId: pairs[edge.index]!.id, type, confidence });
    }
    return out;
  } catch {
    return [];
  }
}
