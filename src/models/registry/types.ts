/**
 * Domain types for the unified model registry.
 * 
 * The registry is the single source of truth for all providers (Ollama, cloud
 * services, local servers) and their models. It replaces the scattered config.json
 * fields (model, fallbackModel, cloudModel, failover.providers) with one coherent
 * data structure.
 * 
 * Keys are NEVER stored in the registry JSON file. They live in:
 * - Electron safeStorage vault (desktop mode): userData/model-secrets/<uuid>.dpapi
 * - Environment variables (web mode or explicit auth.type="env")
 * 
 * The registry stores only credential UUIDs or env var names.
 */

/** Provider protocol/adapter kind. */
export type ProviderKind = "ollama" | "openai-compatible" | "anthropic" | "google-gemini";

/** Provider location classification (for UI grouping and features). */
export type ProviderLocation = "local" | "cloud";

/**
 * Authentication scheme for a provider.
 * 
 * - none: No authentication (local Ollama, llama.cpp without --api-key)
 * - bearer: Authorization: Bearer <token> (most cloud APIs)
 * - header: Custom header like x-api-key or x-goog-api-key
 * - env: Environment variable reference (web mode or user preference)
 * 
 * The `credentialId` is a UUID pointing to a safeStorage-encrypted secret.
 * It NEVER holds the actual key value.
 */
export type AuthScheme =
  | { type: "none" }
  | { type: "bearer"; credentialId: string }
  | { type: "header"; credentialId: string; header: string }
  | { type: "env"; envVar: string };

/**
 * A registered provider: the base URL and protocol for reaching a model source.
 * 
 * One provider can serve multiple models. Examples:
 * - Ollama at localhost:11434 serving qwen2.5:14b, llama3, etc.
 * - OpenRouter at api.openrouter.ai serving hundreds of models
 * - Anthropic API serving claude-3.5-sonnet, claude-opus, etc.
 * 
 * The same base URL with different keys = two provider entries (FreeLLMAPI F05 semantics).
 */
export interface ProviderRecord {
  /** Unique slug identifier [a-z0-9-]{2,40} */
  id: string;
  /** Human-readable name (may contain spaces, Arabic, emoji) */
  label: string;
  /** Protocol adapter to use */
  kind: ProviderKind;
  /** Optional preset this provider was created from */
  presetId?: string;
  /** Base URL (normalized: no trailing slash, http/https only) */
  baseUrl: string;
  /** Derived from hostname; user may override */
  location: ProviderLocation;
  /** Authentication scheme */
  auth: AuthScheme;
  /** Non-secret headers (e.g. x-opencode-session UUID; NOT auth headers) */
  extraHeaders: Record<string, string>;
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** Provider is active in failover chains */
  enabled: boolean;
  /** Timestamps */
  createdAt: string;
  updatedAt: string;
  /** Last connection test result (if any) */
  lastTest?: ConnectionTestResult;
}

/**
 * Capability metadata for one model.
 * 
 * Sources (in priority order):
 * 1. user: User explicitly set this capability
 * 2. probe: Test connection probed with real API call
 * 3. provider-list: Returned by provider's /models or /api/tags
 * 4. preset: Hardcoded in preset definition
 * 5. default: Fallback assumption
 * 
 * Boolean capabilities can be true, false, or "unknown". "unknown" never
 * gates out a request; it's displayed with "?" in the UI and prompts the
 * user to run a test.
 */
export interface ModelCapabilities {
  /** Supports function/tool calling */
  tools: boolean | "unknown";
  /** Supports vision/image inputs */
  vision: boolean | "unknown";
  /** Thinking/reasoning mode: none, toggle (user decides), always (automatic), or unknown */
  thinking: "none" | "toggle" | "always" | "unknown";
  /** Supports JSON mode (constrained output) */
  jsonMode: boolean | "unknown";
  /** Context window size in tokens (null = unknown) */
  contextWindow: number | null;
  /** Max output/completion tokens (null = unknown) */
  maxOutputTokens: number | null;
  /** How this capability metadata was determined */
  source: "user" | "probe" | "provider-list" | "preset" | "default";
}

/**
 * A registered model: the identity and capabilities of one servable model.
 * 
 * Model IDs follow the format `{providerId}/{remoteId}`:
 * - ollama-local/qwen2.5:14b
 * - openrouter/anthropic/claude-3.5-sonnet
 * - anthropic-1/claude-opus-4
 * 
 * The `remoteId` is what gets sent upstream in the model field.
 */
export interface ModelRecord {
  /** Unique identifier: `${providerId}/${remoteId}` */
  id: string;
  /** Provider that serves this model */
  providerId: string;
  /** Model identifier sent to the provider API */
  remoteId: string;
  /** Display name (may differ from remoteId) */
  label: string;
  /** Capability metadata */
  capabilities: ModelCapabilities;
  /** Default parameters for this model */
  defaults: {
    temperature?: number;
    /** Enable thinking mode by default (for models where thinking="toggle") */
    think?: boolean;
    /** Default context window override (Ollama num_ctx) */
    numCtx?: number;
  };
  /** Informational rate limits (not enforced by Loam; enforcement via cooldowns on 429) */
  limits?: {
    rpm?: number; // requests per minute
    rpd?: number; // requests per day
    tpm?: number; // tokens per minute
    tpd?: number; // tokens per day
  };
  /** Model is active for selection */
  enabled: boolean;
  /** User-defined tags for filtering/grouping */
  tags: string[];
}

/**
 * An ordered chain of models for failover.
 * 
 * Loam tries models in sequence. On auth/billing/429 errors, the failing model
 * is cooled down and the next one is tried. Chains replace the legacy
 * cfg.failover.providers ordered list.
 * 
 * Built-in chains:
 * - "default": General assistant work (maps to old cfg.failover.providers)
 * - "coding": Code generation (maps to old cfg.coding.chain)
 * 
 * Users can create custom chains.
 */
export interface ModelChain {
  /** Unique chain identifier */
  id: string;
  /** Display name */
  label: string;
  /** Ordered list of model IDs (full format: providerId/remoteId) */
  modelIds: string[];
}

/**
 * The complete registry: all providers, models, and chains.
 * 
 * Persisted to DATA_DIR/model-registry.json (no secrets).
 * Previous version kept as model-registry.json.bak.
 */
export interface ModelRegistry {
  /** Schema version for future migrations */
  version: 1;
  /** All registered providers */
  providers: ProviderRecord[];
  /** All registered models */
  models: ModelRecord[];
  /** Failover chains */
  chains: ModelChain[];
  /** Primary model for new tasks (replaces cfg.model) */
  defaultModelId: string | null;
  /** Fallback when default fails (replaces cfg.fallbackModel) */
  fallbackModelId: string | null;
  /** Migration provenance (when migrated from legacy config) */
  migratedFrom?: {
    /** ISO timestamp of migration */
    at: string;
    /** SHA-256 of source config (with keys redacted as "<set>"/"<empty>") */
    sourceHash: string;
  };
}

/**
 * Error classification codes for provider failures.
 * 
 * Used by the failover layer to decide cooldown duration and whether to retry.
 */
export type ProviderErrorCode =
  | "unreachable" // Network error, DNS failure, connection refused
  | "timeout" // Request exceeded timeout
  | "auth" // 401 Unauthorized, 403 Forbidden (invalid/expired key)
  | "billing" // 402 Payment Required (quota exceeded, card declined)
  | "rate_limited" // 429 Too Many Requests
  | "not_found" // 404 Not Found (wrong URL, missing endpoint)
  | "bad_request" // 400-499 client error (malformed request)
  | "bad_response" // 500-599 server error, or unparseable response
  | "model_not_found" // Model ID not recognized by provider
  | "unknown"; // Unclassified error

/**
 * Result of a connection test (manual or automatic health check).
 * 
 * Stored in `ProviderRecord.lastTest` and displayed in Settings > Models.
 */
export interface ConnectionTestResult {
  /** ISO timestamp of test */
  at: string;
  /** Test succeeded */
  ok: boolean;
  /** Round-trip time in milliseconds (if ok) */
  latencyMs?: number;
  /** Model ID used for test (if specific model was tested) */
  modelTested?: string;
  /** Number of models discovered via /models or /api/tags (if ok) */
  modelsFound?: number;
  /** Tool calling capability confirmed (if probe ran) */
  toolCalls?: boolean;
  /** Error details (if !ok) */
  error?: {
    code: ProviderErrorCode;
    message: string;
    status?: number; // HTTP status code
  };
}

/**
 * A model discovered from a provider's /models or /api/tags endpoint.
 * 
 * Returned by adapter.listModels() and used in the "Add Model" wizard
 * step 3 (pick models).
 */
export interface DiscoveredModel {
  /** Model identifier to use in API calls */
  remoteId: string;
  /** Display name (if different from remoteId) */
  label?: string;
  /** Context window size (if provider reported it) */
  contextWindow?: number;
  /** Vision support (if known from model ID patterns or provider metadata) */
  vision?: boolean;
  /** Tool calling support (if known) */
  tools?: boolean;
  /** Model kind classification */
  kind?: "chat" | "embedding" | "image" | "audio" | "other";
}
