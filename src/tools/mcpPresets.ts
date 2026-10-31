/**
 * Curated remote MCP presets (blueprint gap 5) — Google, Supabase, Vercel
 * as one-line BYOK entries instead of hand-written transport configs.
 *
 * Usage in config.json:
 *   "mcpServers": { "supabase": { "preset": "supabase" } }
 * The preset fills url/headers/lazy; anything the user also writes (url,
 * headers, allowlist...) overrides the preset. Header values may embed
 * `${ENV:NAME}` tokens — they are resolved at connect time in src/tools/mcp.ts
 * so keys live in the server environment, never in config.json, and a missing
 * key fails that one server with a clear message instead of crashing the boot.
 */
import { log } from "../log.js";
import type { McpServerConfig } from "../config.js";

export interface McpPreset {
  id: string;
  /** Arabic label for settings surfaces. */
  label: string;
  url: string;
  /** Header templates; values may contain ${ENV:NAME} tokens. */
  headers: Record<string, string>;
  /** Env vars the headers reference — listed for setup hints and gates. */
  requiredEnv: string[];
  /** Large catalogues stay out of the prompt (mcp_* bridge reaches them). */
  lazy: boolean;
  docs: string;
  /** Arabic setup hint shown by status surfaces when the key is missing. */
  setupAr: string;
}

const bearer = (envVar: string): string => `Bearer \${ENV:${envVar}}`;

export const MCP_PRESETS: Record<string, McpPreset> = {
  supabase: {
    id: "supabase",
    label: "Supabase (قاعدة البيانات)",
    url: "https://mcp.supabase.com/mcp",
    headers: { authorization: bearer("LOAM_SUPABASE_PAT") },
    requiredEnv: ["LOAM_SUPABASE_PAT"],
    lazy: true,
    docs: "https://supabase.com/docs/guides/getting-started/mcp",
    setupAr: "أنشئ رمز وصول شخصي (PAT) من إعدادات Supabase واضبط LOAM_SUPABASE_PAT على خادم Loam.",
  },
  vercel: {
    id: "vercel",
    label: "Vercel (النشر)",
    url: "https://mcp.vercel.com",
    headers: { authorization: bearer("VERCEL_MCP_TOKEN") },
    requiredEnv: ["VERCEL_MCP_TOKEN"],
    lazy: true,
    docs: "https://vercel.com/docs/mcp",
    setupAr: "أنشئ رمز وصول من Vercel (Access Token) واضبط VERCEL_MCP_TOKEN على خادم Loam — أو مرّر ترويسة oauth بعد إكمال تدفق OAuth.",
  },
  "google-drive": {
    id: "google-drive",
    label: "Google Drive",
    url: "https://mcp.google.com/drive/mcp",
    headers: { authorization: bearer("LOAM_GOOGLE_MCP_TOKEN") },
    requiredEnv: ["LOAM_GOOGLE_MCP_TOKEN"],
    lazy: true,
    docs: "https://developers.google.com/mcp",
    setupAr: "أكمل تفويض Google لخادم MCP ثم اضبط رمز الوصول في LOAM_GOOGLE_MCP_TOKEN (تنتهي صلاحيته دورياً — جدّده).",
  },
  "google-mail": {
    id: "google-mail",
    label: "Gmail",
    url: "https://mcp.google.com/gmail/mcp",
    headers: { authorization: bearer("LOAM_GOOGLE_MCP_TOKEN") },
    requiredEnv: ["LOAM_GOOGLE_MCP_TOKEN"],
    lazy: true,
    docs: "https://developers.google.com/mcp",
    setupAr: "أكمل تفويض Google لخادم MCP ثم اضبط رمز الوصول في LOAM_GOOGLE_MCP_TOKEN (تنتهي صلاحيته دورياً — جدّده).",
  },
};

/** Overlay preset defaults onto user entries that name one (`preset` field).
 *  User-written fields always win. Unknown presets are dropped with a warning
 *  (never a boot crash). The returned configs are preset-free. */
export function applyMcpPresets(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(servers)) {
    const presetId = (entry as { preset?: string }).preset;
    if (!presetId) {
      out[name] = entry;
      continue;
    }
    const preset = MCP_PRESETS[presetId];
    if (!preset) {
      log.warn(`mcpServers["${name}"]: unknown preset "${presetId}" — skipped (known: ${Object.keys(MCP_PRESETS).join(", ")})`);
      continue;
    }
    const { preset: _drop, ...user } = entry;
    out[name] = {
      transport: "http",
      url: preset.url,
      headers: { ...preset.headers },
      lazy: preset.lazy,
      ...user,
    };
  }
  return out;
}

/** Resolve `${ENV:NAME}` tokens in header values at connect time.
 *  Throws (naming the variable, never a value) when a token is unset so the
 *  per-server connect guard in src/tools/mcp.ts reports it cleanly. */
export function expandEnvHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = value.replace(/\$\{ENV:([A-Z0-9_]+)\}/g, (_match, name: string) => {
      const resolved = process.env[name];
      if (resolved === undefined || resolved.trim() === "") {
        throw new Error(`MCP header needs ${name} — set it on the Loam server (BYOK)`);
      }
      return resolved;
    });
  }
  return out;
}
