/**
 * Wiring for the server process: one corpus DB, one encrypted matters DB, the
 * per-task run-model map, and the dependencies the tools and routes share.
 * Created once in src/setup/runtime.ts (buildRuntime) when cfg.legal.enabled.
 */
import { QatarLawLibrary, defaultLibraryPath } from "./library.js";
import path from "node:path";
import fs from "node:fs";
import type { LegalToolDeps } from "../tools/legalTools.js";
import type { LegalConfig } from "./config.js";
import { LegalCorpus } from "./corpusStore.js";
import { FieldCipher, processKeyProvider, type KeyProvider } from "./crypto.js";
import { isApprovedLocal, type EgressConfig } from "./egress.js";
import { MattersStore } from "./mattersStore.js";
import { createLegalModelPort } from "./model/legalModelPort.js";
import type { LegalModelPort } from "./model/types.js";
import { createLegalBackup, inspectLegalBackup, restoreLegalBackup } from "./security/backup.js";
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
import { OidcVerifier } from "../security/enterprise/oidc.js";
import type { LegalIdentityProvider } from "./security/access.js";

export const UNREGISTERED_RUN_MODEL = "unregistered-run";

export interface LegalRuntime {
  config: LegalConfig;
  corpus: LegalCorpus;
  matters: MattersStore;
  egress: EgressConfig;
  keys: KeyProvider;
  identity?: LegalIdentityProvider;
  vault: LegalFileVault;
  model: { port: LegalModelPort };
  buildDefense(matterId: string): ReturnType<typeof buildDefensePackage>;
  buildResponse(input: { matterId: string; sourceText: string }): ReturnType<typeof buildLegalResponse>;
  analyzeDocuments(matterId: string): ReturnType<typeof analyzeDocuments>;
  importDocument(matterId: string, absPath: string): Promise<EvidenceAnalysis>;
  runModels: Map<string, string>;
  toolDeps: LegalToolDeps;
  /** Read-only Qatar law research library (search.db + Markdown); may be absent on disk. */
  library: QatarLawLibrary;
  seal(value: unknown, aad: string): SealedLegalPayload;
  open<T>(payload: unknown): T;
  backup(outputPath: string, passphrase: string): void;
  createBackup(passphrase: string): { fileName: string; files: number };
  restoreBackup(fileName: string, passphrase: string): { directory: string; restored: string[] };
  listBackups(): string[];
  purgeExpired(): string[];
  createAuditAnchor(): { fileName: string; anchor: AuditAnchor };
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
  const library = new QatarLawLibrary(opts.config.libraryPath ?? defaultLibraryPath(opts.dataDir));
  const keys = opts.keys ?? processKeyProvider;
  const matters = new MattersStore(mattersPath, keys, opts.now, opts.config.retentionDays);
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
  const backupsDir = path.join(dir, "backups");
  const recoveriesDir = path.join(dir, "recoveries");
  const writeBackup = (outputPath: string, passphrase: string): void => {
    matters.db.exec("PRAGMA wal_checkpoint(FULL)");
    corpus.db.exec("PRAGMA wal_checkpoint(FULL)");
    createLegalBackup({ outputPath, mattersPath, corpusPath, filesDir: path.join(dir, "files"), keys, passphrase, ...(opts.now ? { now: opts.now } : {}) });
  };
  const runtime: LegalRuntime = {
    config: opts.config, corpus, library, matters, egress, keys, vault, model, runModels, toolDeps,
    ...(opts.config.identity ? { identity: { tenantId: opts.config.identity.tenantId, verifier: new OidcVerifier({ issuer: opts.config.identity.issuer, audience: opts.config.identity.audience }) } } : {}),
    importDocument: (matterId, absPath) => importMatterDocument(matters, matterId, absPath, { ocr: localLegalOcr, rasterize: rasterizePdfPage, ...(opts.now ? { now: opts.now } : {}) }),
    buildDefense: (matterId) => buildDefensePackage(matters, corpus, { port: model.port, config: egress }, matterId),
    buildResponse: (input) => buildLegalResponse(matters, corpus, { port: model.port, config: egress }, input),
    analyzeDocuments: (matterId) => analyzeDocuments(matters, corpus, { port: model.port, config: egress }, matterId),
    seal: (value, aad) => sealLegalPayload(cipher, value, aad),
    open: <T>(payload: unknown): T => openLegalPayload<T>(cipher, payload),
    backup: writeBackup,
    createBackup: (passphrase) => {
      const fileName = `legal-${(opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-")}-${process.pid}.loam-legal`;
      const outputPath = path.join(backupsDir, fileName);
      writeBackup(outputPath, passphrase);
      return { fileName, files: inspectLegalBackup(outputPath, passphrase).files.length };
    },
    restoreBackup: (fileName, passphrase) => {
      if (!/^[A-Za-z0-9._-]{1,128}\.loam-legal$/.test(fileName)) throw new Error("invalid legal backup file name");
      const directory = path.join(recoveriesDir, `recovery-${Date.now()}-${process.pid}`);
      const restored = restoreLegalBackup({ inputPath: path.join(backupsDir, fileName), mattersPath: path.join(directory, "matters.db"), corpusPath: path.join(directory, "qatar-law.db"), filesDir: path.join(directory, "files"), passphrase });
      return { directory, restored: restored.restored };
    },
    listBackups: () => fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((name) => /^[A-Za-z0-9._-]{1,128}\.loam-legal$/.test(name)).sort().reverse() : [],
    purgeExpired: () => matters.purgeExpired("retention-policy"),
    createAuditAnchor: () => {
      const fileName = `audit-${(opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`;
      return { fileName, anchor: exportAuditAnchor(matters.audit, path.join(backupsDir, fileName), keys, opts.now) };
    },
    exportAuditAnchor: (outputPath) => exportAuditAnchor(matters.audit, outputPath, keys, opts.now),
    close: () => { clearInterval(maintenance); corpus.close(); library.close(); matters.close(); void closeLegalOcr(); },
  };
  let nextBackupAt = (opts.now?.() ?? new Date()).getTime() + (opts.config.backupIntervalHours ?? 0) * 3_600_000;
  const maintenance = setInterval(() => {
    try {
      matters.purgeExpired("retention-policy");
      if (opts.config.backupIntervalHours && (opts.now?.() ?? new Date()).getTime() >= nextBackupAt) {
        runtime.createBackup(keys.key().toString("hex"));
        nextBackupAt = (opts.now?.() ?? new Date()).getTime() + opts.config.backupIntervalHours * 3_600_000;
      }
    } catch { console.error("legal scheduled maintenance failed"); }
  }, 60_000);
  maintenance.unref();
  return runtime;
}
