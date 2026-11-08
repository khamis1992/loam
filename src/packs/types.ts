export type PackId = "loam-slides" | "loam-localfile" | "loam-video" | "loam-build" | "loam-image" | "loam-audio" | "loam-office" | "loam-research" | "loam-schedule" | "loam-mobile" | "loam-game" | "loam-desktop";

export interface ServicePackManifest {
  schema: "loam.service-pack/v1";
  id: PackId;
  version: string;
  modes: string[];
  skills: Array<{ name: string; path: string }>;
  wraps: string[];
  ownedTools: string[];
  wrappedTools: string[];
  modelTools: string[];
  hostTools: string[];
  gate: { tool: string; timeoutMs: number };
  legacyRoutes: "keep" | "retired";
  providers?: Array<{ capability: "image" | "video" | "tts" | "music" | "llm"; optional: boolean }>;
  update: "hot" | "restart";
}

export interface PackItem {
  id: string;
  state: "pending" | "authored" | "invalid" | "final";
  path?: string;
  errors?: string[];
}

export interface PackProject {
  projectId: string;
  packId: PackId;
  revision: number;
  items: PackItem[];
  dir?: string;
  baseline?: Record<string, string>;
  data?: Record<string, unknown>;
}

export type PresentResult =
  | { ok: true; uri: string; artifacts: string[] }
  | { ok: false; missing: string[]; errors: string[]; retry: boolean; code?: "timeout" | "provider_not_configured"; message?: string };
