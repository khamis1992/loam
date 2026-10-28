/**
 * Wiring for the server process: one corpus DB, one encrypted matters DB, the
 * per-task run-model map, and the dependencies the tools and routes share.
 * Created once in src/setup/runtime.ts (buildRuntime) when cfg.legal.enabled.
 */
import path from "node:path";
import type { LegalToolDeps } from "../tools/legalTools.js";
import type { LegalConfig } from "./config.js";
import { LegalCorpus } from "./corpusStore.js";
import { FieldCipher, processKeyProvider, type KeyProvider } from "./crypto.js";
import { isApprovedLocal, type EgressConfig } from "./egress.js";
import { MattersStore } from "./mattersStore.js";
import { createLegalModelPort } from "./model/legalModelPort.js";
import type { LegalModelPort } from "./model/types.js";
import { createLegalBackup } from "./security/backup.js";
import { exportAuditAnchor, type AuditAnchor } from "./security/auditAnchor.js";
import { LegalFileVault } from "./security/fileVault.js";
import { localLegalOcr, closeLegalOcr } from "./evidence/ocr.js";
import { rasterizePdfPage } from "./evidence/pdfRaster.js";
import { importMatterDocument, type EvidenceAnalysis } from "./evidence/service.js";
import { buildDefensePackage } from "./defense/service.js";
import { buildLegalResponse } from "./response/service.js";
import { analyzeDocuments } from "./analysis/documentAnalysis.js";
import { openLegalPayload, sealLegalPayload, type SealedLegalPayload } from "./security/transcriptSeal.js";
import type { Embedder, Reranker } from "./retrieval.js";

export const UNREGISTERED_RUN_MODEL = "unregistered-run";

export interface LegalRuntime {
  config: LegalConfig;
  corpus: LegalCorpus;
  matters: MattersStore;
  egress: EgressConfig;
  keys: KeyProvider;
  vault: LegalFileVault;
  model: { port: LegalModelPort };
  buildDefense(matterId: string): ReturnType<typeof buildDefensePackage>;
  buildResponse(input: { matterId: string; sourceText: string }): ReturnType<typeof buildLegalResponse>;
  analyzeDocuments(matterId: string): ReturnType<typeof analyzeDocuments>;
  importDocument(matterId: string, absPath: string): Promise<EvidenceAnalysis>;
  runModels: Map<string, string>;
  toolDeps: LegalToolDeps;
  seal(value: unknown, aad: string): SealedLegalPayload;
  open<T>(payload: unknown): T;
  backup(outputPath: string, passphrase: string): void;
  exportAuditAnchor(outputPath: string): AuditAnchor;
  close(): void;
}

export interface LegalRuntimeOptions {
  dataDir: string;
  config: LegalConfig;
  ollamaUrl: string;
  keys?: KeyProvider;
  embedder?: Embedder;
  reranker?: Reranker;
  extractText?: (absPath: string) => Promise<string>;
  now?: () => Date;
}

export function createLegalRuntime(opts: LegalRuntimeOptions): LegalRuntime {
  const dir = path.join(opts.dataDir, "legal");
  const corpusPath = opts.config.corpusPath ?? path.join(dir, "qatar-law.db");
  const mattersPath = opts.config.mattersPath ?? path.join(dir, "matters.db");
  const corpus = new LegalCorpus(corpusPath);
  const keys = opts.keys ?? processKeyProvider;
  const matters = new MattersStore(mattersPath, keys, opts.now);
  const cipher = new FieldCipher(keys);
  const vault = new LegalFileVault(path.join(dir, "files"), keys);
  const egress: EgressConfig = { localModel: opts.config.localModel, approvedLocalModels: opts.config.approvedLocalModels, ollamaUrl: opts.ollamaUrl };
  const model = createLegalModelPort({ config: egress });
  const runModels = new Map<string, string>();
  const toolDeps: LegalToolDeps = {
    corpus,
    matters,
    egress,
    runModelFor: (taskId) => (taskId ? runModels.get(taskId) : undefined) ?? UNREGISTERED_RUN_MODEL,
    ...(opts.embedder && opts.config.embedModel && isApprovedLocal(opts.config.embedModel, egress) ? { embedder: opts.embedder, embedModel: opts.config.embedModel } : {}),
    ...(opts.reranker && opts.config.rerank === "llm" ? { reranker: opts.reranker } : {}),
    ...(opts.extractText ? { extractText: opts.extractText } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  };
  return {
    config: opts.config, corpus, matters, egress, keys, vault, model, runModels, toolDeps,
    importDocument: (matterId, absPath) => importMatterDocument(matters, matterId, absPath, { ocr: localLegalOcr, rasterize: rasterizePdfPage, ...(opts.now ? { now: opts.now } : {}) }),
    buildDefense: (matterId) => buildDefensePackage(matters, corpus, { port: model.port, config: egress }, matterId),
    buildResponse: (input) => buildLegalResponse(matters, corpus, { port: model.port, config: egress }, input),
    analyzeDocuments: (matterId) => analyzeDocuments(matters, corpus, { port: model.port, config: egress }, matterId),
    seal: (value, aad) => sealLegalPayload(cipher, value, aad),
    open: <T>(payload: unknown): T => openLegalPayload<T>(cipher, payload),
    backup: (outputPath, passphrase) => {
      matters.db.exec("PRAGMA wal_checkpoint(FULL)");
      corpus.db.exec("PRAGMA wal_checkpoint(FULL)");
      createLegalBackup({ outputPath, mattersPath, corpusPath, filesDir: path.join(dir, "files"), keys, passphrase, ...(opts.now ? { now: opts.now } : {}) });
    },
    exportAuditAnchor: (outputPath) => exportAuditAnchor(matters.audit, outputPath, keys, opts.now),
    close: () => { corpus.close(); matters.close(); void closeLegalOcr(); },
  };
}
