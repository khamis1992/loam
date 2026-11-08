/**
 * `legal` block of Loam's config (src/config.ts `Config.legal`, defaults in
 * DEFAULT_CONFIG, user overrides in config.json / Settings › Legal).
 */
export interface LegalIdentityConfig {
  issuer: string;
  audience: string;
  tenantId: string;
}

export interface LegalConfig {
  /** Off by default: the legal mode, tools and routes appear only when enabled. */
  enabled: boolean;
  /** The model legal runs use for client text (Khamis: only qwen3.6:35b-a3b is approved). */
  localModel: string;
  /** Explicit allowlist; a local model outside it is treated like a cloud model. */
  approvedLocalModels: string[];
  /** "" = lexical retrieval only (default). An Ollama embedding model id enables the vector channel. */
  embedModel: string;
  /** "off" (default) or "llm": rerank top candidates with the local model. */
  rerank: "off" | "llm";
  /** Days after which a matter is purged; null = keep until the user deletes it. */
  retentionDays: number | null;
  /** Encrypted local backup interval; null disables scheduled backups. The recovery secret is never stored in config. */
  backupIntervalHours: number | null;
  /** Override DB locations (tests, portable installs). Default <DATA_DIR>/legal/. */
  corpusPath?: string;
  mattersPath?: string;
  /** Qatar law research library (search.db + Markdown). Default <DATA_DIR>/legal/library. */
  libraryPath?: string;
  /** Optional signed enterprise identity. Without it, Legal uses the single local desktop identity. */
  identity?: LegalIdentityConfig;
}

export const DEFAULT_LEGAL_CONFIG: LegalConfig = {
  enabled: false,
  localModel: "qwen3.6:35b-a3b",
  approvedLocalModels: ["qwen3.6:35b-a3b"],
  embedModel: "",
  rerank: "off",
  retentionDays: null,
  backupIntervalHours: null,
};

/** Clamp a partial user config onto the defaults (same pattern as config.ts normalizers). */
export function normalizeLegalConfig(raw: unknown): LegalConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<LegalConfig>;
  const approved = Array.isArray(r.approvedLocalModels) ? r.approvedLocalModels.filter((m): m is string => typeof m === "string" && m.trim() !== "") : DEFAULT_LEGAL_CONFIG.approvedLocalModels;
  const identity = r.identity && typeof r.identity.issuer === "string" && typeof r.identity.audience === "string" && typeof r.identity.tenantId === "string" && r.identity.issuer.trim() && r.identity.audience.trim() && r.identity.tenantId.trim()
    ? { issuer: r.identity.issuer.trim(), audience: r.identity.audience.trim(), tenantId: r.identity.tenantId.trim() } : undefined;
  return {
    enabled: r.enabled === true,
    localModel: typeof r.localModel === "string" && r.localModel.trim() ? r.localModel.trim() : DEFAULT_LEGAL_CONFIG.localModel,
    approvedLocalModels: approved,
    embedModel: typeof r.embedModel === "string" ? r.embedModel.trim() : "",
    rerank: r.rerank === "llm" ? "llm" : "off",
    retentionDays: typeof r.retentionDays === "number" && r.retentionDays > 0 ? Math.floor(r.retentionDays) : null,
    backupIntervalHours: typeof r.backupIntervalHours === "number" && r.backupIntervalHours >= 1 ? Math.min(24 * 30, Math.floor(r.backupIntervalHours)) : null,
    ...(typeof r.corpusPath === "string" && r.corpusPath ? { corpusPath: r.corpusPath } : {}),
    ...(typeof r.mattersPath === "string" && r.mattersPath ? { mattersPath: r.mattersPath } : {}),
    ...(typeof r.libraryPath === "string" && r.libraryPath.trim() ? { libraryPath: r.libraryPath.trim() } : {}),
    ...(identity ? { identity } : {}),
  };
}
