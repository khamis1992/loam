/**
 * Provider presets for the unified model registry.
 * 
 * Presets with `verified: false` are hidden from the UI preset dropdown
 * until Phase 0 verification confirms them (Decision D6). "Custom" provider
 * is always available regardless of verification status.
 * 
 * Evidence references point to:
 * - Loam source files (L##)
 * - FreeLLMAPI source (F##)
 * - docs/model-registry/verification.md
 */

export type ProviderKind = "ollama" | "openai-compatible" | "anthropic" | "google-gemini";
export type ProviderLocation = "local" | "cloud";

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  location: ProviderLocation;
  /** "none" | "bearer" | { header: string } for custom header auth */
  auth: "none" | "bearer" | { header: string };
  /** Suggested environment variable name for the API key */
  keyEnvHint?: string;
  /** Verified against official docs or live testing (Phase 0) */
  verified: boolean;
  /** Evidence source (file ref, URL, or doc section) */
  evidence: string;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: "ollama",
    label: "Ollama",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    location: "local",
    auth: "none",
    verified: true,
    evidence: "Loam L07/L16, in production use",
  },
  {
    id: "freellmapi",
    label: "FreeLLMAPI",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:31415/v1",
    location: "local",
    auth: "bearer",
    keyEnvHint: "FREELLM_API_KEY",
    verified: true,
    evidence: "Loam L07; FreeLLMAPI F15 + README unified key (l.156)",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    location: "cloud",
    auth: "bearer",
    keyEnvHint: "OPENROUTER_API_KEY",
    verified: true,
    evidence: "Loam L07/L16, in production use",
  },
  {
    id: "longcat",
    label: "LongCat",
    kind: "openai-compatible",
    baseUrl: "https://api.longcat.chat/openai/v1",
    location: "cloud",
    auth: "bearer",
    keyEnvHint: "LONGCAT_API_KEY",
    verified: true,
    evidence: "Loam L07 (comment cites LongCat Quick Start)",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    kind: "openai-compatible",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    location: "cloud",
    auth: "bearer",
    keyEnvHint: "OPENCODE_API_KEY",
    verified: true,
    evidence: "docs/model-registry/verification.md (U-L3 resolved: Loam L07 URL chosen over FreeLLMAPI F08 alternative)",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    location: "local",
    auth: "none",
    verified: true,
    evidence: "docs/model-registry/verification.md (standard default port per LM Studio docs)",
  },
  {
    id: "llamacpp",
    label: "llama.cpp server",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1",
    location: "local",
    auth: "none",
    verified: true,
    evidence: "docs/model-registry/verification.md (standard default port per llama.cpp docs)",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    location: "cloud",
    auth: "bearer",
    keyEnvHint: "OPENAI_API_KEY",
    verified: true,
    evidence: "docs/model-registry/verification.md (standard OpenAI API)",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    location: "cloud",
    auth: { header: "x-api-key" },
    keyEnvHint: "ANTHROPIC_API_KEY",
    verified: true,
    evidence: "docs/model-registry/verification.md (U-A1: verified against Anthropic API docs)",
  },
  {
    id: "google",
    label: "Google Gemini",
    kind: "google-gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    location: "cloud",
    auth: { header: "x-goog-api-key" },
    keyEnvHint: "GEMINI_API_KEY",
    verified: true,
    evidence: "docs/model-registry/verification.md (U-G1: verified against Google Generative AI docs; D4: native adapter chosen)",
  },
  {
    id: "zai",
    label: "z.ai (GLM)",
    kind: "openai-compatible",
    baseUrl: "", // User must provide; no public docs available (U-Z1)
    location: "cloud",
    auth: "bearer",
    keyEnvHint: "ZAI_API_KEY",
    verified: false,
    evidence: "docs/model-registry/verification.md (U-Z1: base URL unknown, user must provide via Custom option)",
  },
];

/**
 * Get presets filtered by verification status.
 * 
 * @param showAll - If true, return all presets including unverified ones
 * @returns Array of provider presets
 */
export function getPresets(showAll = false): ProviderPreset[] {
  if (showAll) return PRESETS;
  return PRESETS.filter((p) => p.verified);
}

/**
 * Get a preset by ID.
 * 
 * @param id - Preset identifier
 * @returns Preset if found, undefined otherwise
 */
export function getPresetById(id: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
