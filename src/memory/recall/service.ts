import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { editCore, readCore, rollbackCore } from "./core.js";
import { defaultRecallConfig } from "./defaults.js";
import { extractFacts } from "./extract.js";
import { isIdle } from "./idle.js";
import { runGardenerTick } from "./gardener.js";
import { rememberFact } from "./link.js";
import { RecallRepo } from "./repo.js";
import { buildRecallBlock, rerankBreaker, searchMemories } from "./search.js";
import { isTrivialMessage } from "./normalize.js";
import type {
  CoreEdit, CoreEditResult, Embedder, GardenerReport, MemoryRecord, RecallConfig, RecallStats,
  RememberInput, RememberResult, SearchHit, SearchQuery, TextModel,
} from "./types.js";
import { newId, toUnit } from "./vectors.js";

export interface RecallService {
  remember(input: RememberInput): Promise<RememberResult>;
  ingestTurn(turn: { sessionId: string; scope: string; userText: string; assistantText: string }): void;
  drainIngest(now?: number): Promise<number>;
  search(q: SearchQuery): Promise<SearchHit[]>;
  temporal(range: { since: number; until: number; scope?: string[] }): Promise<MemoryRecord[]>;
  forget(id: string, mode: "soft" | "hard"): Promise<void>;
  restore(id: string): Promise<void>;
  confirm(id: string): Promise<void>;
  injection(text: string, scope: string, allowLegal?: boolean): Promise<string>;
  core: {
    get(scope: string): Promise<import("./types.js").CoreBlocks>;
    edit(op: CoreEdit): Promise<CoreEditResult>;
    rollback(historyId: string): Promise<void>;
  };
  gardener: { tick(kind: "light" | "deep" | "sleep", opts?: { force?: boolean; now?: number }): Promise<GardenerReport> };
  stats(): Promise<RecallStats>;
  repo: RecallRepo;
  config: RecallConfig;
}

export function createRecallService(db: DatabaseSync, opts: {
  embedder?: Embedder;
  model?: TextModel;
  config?: Partial<RecallConfig>;
  dbBytes?: () => number;
} = {}): RecallService {
  const repo = new RecallRepo(db);
  const config = defaultRecallConfig(opts.config);
  const embedders = new Set(["nomic-embed-text:latest", "bge-m3", "embeddinggemma"]);
  function liveConfig(): RecallConfig {
    let next = config;
    const rerank = repo.getSetting("rerank");
    if (rerank === "0" || rerank === "1") next = { ...next, rerank: { ...next.rerank, enabled: rerank === "1" } };
    const embedderName = repo.getSetting("embedder");
    if (embedderName && embedders.has(embedderName)) next = { ...next, models: { ...next.models, embedder: embedderName } };
    return next;
  }
  const embed = async (text: string): Promise<Float32Array | undefined> => {
    if (!opts.embedder) return undefined;
    const [vec] = await opts.embedder.embed([text]);
    if (!vec) return undefined;
    return toUnit(vec);
  };

  const service: RecallService = {
    repo,
    config,
    remember(input) { return rememberFact(repo, liveConfig(), opts.embedder, opts.model, input); },
    ingestTurn(turn) {
      repo.enqueue(newId("ing_"), turn, Date.now());
      queueMicrotask(() => { void service.drainIngest(); });
    },
    async drainIngest(now = Date.now()) {
      if (!isIdle() || !opts.model) return 0;
      const due = repo.dueQueue(now);
      let done = 0;
      for (const item of due) {
        try {
          const payload = JSON.parse(item.payload) as { sessionId: string; scope: string; userText: string; assistantText: string };
          const facts = await extractFacts(opts.model, payload.userText, payload.assistantText);
          for (const fact of facts) {
            await rememberFact(repo, liveConfig(), opts.embedder, opts.model, {
              content: fact.content,
              scope: payload.scope,
              kind: fact.kind,
              importance: fact.importance,
              confidence: fact.confidence,
              origin: "assistant",
              ...(fact.eventAt !== undefined ? { eventAt: fact.eventAt } : {}),
              sourceRef: { sessionId: payload.sessionId },
            }, now);
          }
          repo.finishQueue(item.id);
          done += 1;
        } catch (error) {
          repo.failQueue(item.id, item.attempts + 1, now + 60_000, error instanceof Error ? error.message : String(error));
        }
      }
      return done;
    },
    search(q) { return searchMemories(repo, liveConfig(), embed, opts.model, q); },
    async temporal(range) { return repo.temporal(range.since, range.until, range.scope); },
    async forget(id, mode) {
      const memory = repo.get(id);
      if (!memory) return;
      if (mode === "hard") {
        repo.hardDelete(id);
        return;
      }
      repo.update({ ...memory, state: "trashed", trashedAt: Date.now(), isLatest: false, updatedAt: Date.now() });
      repo.event(id, "trash", { mode: "soft" });
    },
    async restore(id) {
      const memory = repo.get(id);
      if (!memory) return;
      repo.update({ ...memory, state: "active", isLatest: true, trashedAt: undefined, updatedAt: Date.now() });
      repo.event(id, "restore");
    },
    async confirm(id) { repo.confirm(id, Date.now()); },
    async injection(text, scope, allowLegal = false) {
      if (config.injection.skipTrivial && isTrivialMessage(text)) return "";
      const core = readCore(repo, scope, config.coreLimits);
      const hits = await searchMemories(repo, liveConfig(), embed, opts.model, {
        text, scope: [scope, "user"], limit: config.injection.maxItems, allowLegal,
      });
      if (hits.length === 0 && core.user.length === 0 && core.environment.length === 0) return "";
      return buildRecallBlock(hits, core.user, core.environment, config.injection.maxItems, config.injection.maxTokens);
    },
    core: {
      async get(scope) { return readCore(repo, scope, config.coreLimits); },
      async edit(op) { return editCore(repo, op, config.coreLimits); },
      async rollback(historyId) { rollbackCore(repo, historyId); },
    },
    gardener: {
      tick(kind, tickOpts) { return runGardenerTick(repo, config, kind, opts.model, tickOpts); },
    },
    async stats() {
      const counts = repo.stats();
      const byState = { active: 0, dormant: 0, archived: 0, superseded: 0, trashed: 0, ...counts.byState };
      return {
        total: counts.total,
        byState,
        byScope: counts.byScope,
        dbBytes: opts.dbBytes?.() ?? 0,
        ...(repo.lastSleepAt() !== undefined ? { lastSleepAt: repo.lastSleepAt() } : {}),
        ...(rerankBreaker().p50() !== undefined ? { rerankP50Ms: rerankBreaker().p50() } : {}),
        fts: repo.schema.fts,
      };
    },
  };
  return service;
}

export function openRecallFile(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new DatabaseSync(file);
}
