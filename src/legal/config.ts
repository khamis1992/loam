/**
 * `legal` block of Loam's config (src/config.ts `Config.legal`, defaults in
 * DEFAULT_CONFIG, user overrides in config.json / Settings › Legal).
 */
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
  /** Override DB locations (tests, portable installs). Default <DATA_DIR>/legal/. */
  corpusPath?: string;
  mattersPath?: string;
}

export const DEFAULT_LEGAL_CONFIG: LegalConfig = {
  enabled: false,
  localModel: "qwen3.6:35b-a3b",
  approvedLocalModels: ["qwen3.6:35b-a3b"],
  embedModel: "",
  rerank: "off",
  retentionDays: null,
};

/** Clamp a partial user config onto the defaults (same pattern as config.ts normalizers). */
export function normalizeLegalConfig(raw: unknown): LegalConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<LegalConfig>;
  const approved = Array.isArray(r.approvedLocalModels) ? r.approvedLocalModels.filter((m): m is string => typeof m === "string" && m.trim() !== "") : DEFAULT_LEGAL_CONFIG.approvedLocalModels;
  return {
    enabled: r.enabled === true,
    localModel: typeof r.localModel === "string" && r.localModel.trim() ? r.localModel.trim() : DEFAULT_LEGAL_CONFIG.localModel,
    approvedLocalModels: approved,
    embedModel: typeof r.embedModel === "string" ? r.embedModel.trim() : "",
    rerank: r.rerank === "llm" ? "llm" : "off",
    retentionDays: typeof r.retentionDays === "number" && r.retentionDays > 0 ? Math.floor(r.retentionDays) : null,
    ...(typeof r.corpusPath === "string" && r.corpusPath ? { corpusPath: r.corpusPath } : {}),
    ...(typeof r.mattersPath === "string" && r.mattersPath ? { mattersPath: r.mattersPath } : {}),
  };
}
