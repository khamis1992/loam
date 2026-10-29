// src/appbuilder/localCloud.ts — Cap G §4.10.4: AI in generated apps runs on the
// user's OWN provider key (OD-12). Loam runs no shared proxy and holds no Loam-owned
// key. The key lives in the secrets vault (scope appbuilder-ai, sealed AES-256-GCM,
// registered with the log redactor); URL/model in meta or per-project columns.
// aiEnvFor() is server-side only and goes straight into the API server's spawn env.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getMeta, setMeta } from "../server/sqliteStore.js";
import { deleteSecret, listSecrets, resolveSecret, setSecret } from "../server/secretsVault.js";
import { getAppProject, updateAppProject } from "./projects.js";
import type { AppAiProjectConfig, AppAiProviderPublic, AppAiUsageDay, AppProject } from "./types.js";

export const AI_VAULT_SCOPE = "appbuilder-ai";
export const DEFAULT_KEY_NAME = "default-key";
const META_BASE_URL = "appbuilder.ai.baseUrl";
const META_MODEL = "appbuilder.ai.model";
export const CAP_MIN = 1_000;
export const CAP_MAX = 100_000_000;
const MODEL_RE = /^[A-Za-z0-9._:/@-]{1,120}$/;

export const projectKeyName = (projectId: string): string => `project-${projectId}`;
const hasSecretIn = (scope: string, name: string): boolean => listSecrets(scope).some((s) => s.name === name);
const hasSecret = (name: string): boolean => hasSecretIn(AI_VAULT_SCOPE, name);

export function checkBaseUrl(raw: string): string | { error: string } {
  const value = raw.trim().replace(/\/+$/, "");
  if (value.length > 300) return { error: "base_url_too_long" };
  let u: URL;
  try { u = new URL(value); } catch { return { error: "base_url_invalid" }; }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return { error: "base_url_must_be_https" };
  if (u.username || u.password) return { error: "base_url_has_credentials" };
  return value;
}

export function defaultProvider(): AppAiProviderPublic {
  return { baseUrl: getMeta(META_BASE_URL) ?? "", model: getMeta(META_MODEL) ?? "", hasKey: hasSecret(DEFAULT_KEY_NAME) };
}

/** `key: ""` clears the stored key. The key is never returned. */
export function setDefaultProvider(body: { baseUrl?: unknown; model?: unknown; key?: unknown }): { provider: AppAiProviderPublic } | { error: string } {
  if (typeof body.baseUrl === "string") {
    const url = checkBaseUrl(body.baseUrl);
    if (typeof url !== "string") return url;
    setMeta(META_BASE_URL, url);
  }
  if (typeof body.model === "string") {
    if (!MODEL_RE.test(body.model.trim())) return { error: "model_invalid" };
    setMeta(META_MODEL, body.model.trim());
  }
  if (typeof body.key === "string") {
    if (body.key === "") deleteSecret(AI_VAULT_SCOPE, DEFAULT_KEY_NAME);
    else {
      const stored = setSecret(AI_VAULT_SCOPE, DEFAULT_KEY_NAME, body.key.trim());
      if (stored !== true) return stored;
    }
  }
  return { provider: defaultProvider() };
}

export function projectAiConfig(project: AppProject): AppAiProjectConfig {
  const def = defaultProvider();
  const projectKey = hasSecret(projectKeyName(project.id));
  const keySource = projectKey ? "project" : def.hasKey ? "default" : "none";
  return {
    keySource,
    effective: { baseUrl: project.ai.baseUrl ?? def.baseUrl, model: project.ai.model ?? def.model, hasKey: keySource !== "none" },
    dailyTokenCap: project.ai.dailyTokenCap,
  };
}

/** null for baseUrl/model returns to the default provider; key "" removes the project key; dailyTokenCap null turns the cap off. */
export function setProjectAi(projectId: string, body: { baseUrl?: unknown; model?: unknown; key?: unknown; dailyTokenCap?: unknown }): { config: AppAiProjectConfig } | { error: string } {
  const project = getAppProject(projectId);
  if (!project) return { error: "not_found" };
  const ai = { ...project.ai };
  if (body.baseUrl === null) ai.baseUrl = null;
  else if (typeof body.baseUrl === "string") {
    const url = checkBaseUrl(body.baseUrl);
    if (typeof url !== "string") return url;
    ai.baseUrl = url;
  }
  if (body.model === null) ai.model = null;
  else if (typeof body.model === "string") {
    if (!MODEL_RE.test(body.model.trim())) return { error: "model_invalid" };
    ai.model = body.model.trim();
  }
  if (body.dailyTokenCap === null) ai.dailyTokenCap = null;
  else if (body.dailyTokenCap !== undefined) {
    const n = Number(body.dailyTokenCap);
    if (!Number.isInteger(n) || n < CAP_MIN || n > CAP_MAX) return { error: "cap_out_of_range" };
    ai.dailyTokenCap = n;
  }
  if (typeof body.key === "string") {
    if (body.key === "") deleteSecret(AI_VAULT_SCOPE, projectKeyName(projectId));
    else {
      const stored = setSecret(AI_VAULT_SCOPE, projectKeyName(projectId), body.key.trim());
      if (stored !== true) return stored;
    }
  }
  const updated = updateAppProject(projectId, { ai });
  return { config: projectAiConfig(updated) };
}

/** Server side only. The returned object goes straight into the API server's spawn env and nowhere else. */
export function aiEnvFor(project: AppProject): Record<string, string> {
  const cfg = projectAiConfig(project);
  if (cfg.keySource === "none" || !cfg.effective.baseUrl || !cfg.effective.model) return {};
  const key = resolveSecret(AI_VAULT_SCOPE, cfg.keySource === "project" ? projectKeyName(project.id) : DEFAULT_KEY_NAME);
  if (!key) return {};
  const env: Record<string, string> = { AI_BASE_URL: cfg.effective.baseUrl, AI_API_KEY: key, AI_MODEL: cfg.effective.model };
  if (cfg.dailyTokenCap !== null) env.AI_DAILY_TOKEN_CAP = String(cfg.dailyTokenCap);
  return env;
}

// ---------- Stripe BYOK (W4b): the user's own Stripe key for generated apps ----------
// Same rule as the AI key above: Loam holds no key of its own. The user's Stripe
// secret key is stored in the vault (scope appbuilder-app, sealed + redactor
// registered) or read from the user's own Loam process environment, and goes
// ONLY into the spawned app server's env (stripeEnvFor → DevServerHooks.aiEnv,
// devServer.ts). It is never logged, never returned by any route, and never
// written into app code. scrubEnv (subagent/env.ts) drops STRIPE_* from the
// inherited env, so the aiEnv spread is the single sanctioned passthrough.

export const APP_VAULT_SCOPE = "appbuilder-app";
export const STRIPE_KEY_NAME = "stripe-key";
export const STRIPE_WEBHOOK_NAME = "stripe-webhook-secret";

const cleanSecret = (raw: string | undefined): string | null => {
  const v = raw?.trim();
  return v && v.length >= 20 && v.length <= 512 && !/\s/.test(v) ? v : null;
};

/** Where the app server's Stripe key would come from, for the UI. Values never leave. */
export function stripeStatus(): { hasKey: boolean; hasWebhookSecret: boolean; source: "vault" | "environment" | "none" } {
  const vaultKey = hasSecretIn(APP_VAULT_SCOPE, STRIPE_KEY_NAME);
  const envKey = cleanSecret(process.env.STRIPE_KEY);
  return {
    hasKey: vaultKey || Boolean(envKey),
    hasWebhookSecret: hasSecretIn(APP_VAULT_SCOPE, STRIPE_WEBHOOK_NAME) || Boolean(cleanSecret(process.env.STRIPE_WEBHOOK_SECRET)),
    source: vaultKey ? "vault" : envKey ? "environment" : "none",
  };
}

/** `""` clears. Stored sealed; the value is never returned by this or any route. */
export function setAppStripe(body: { key?: unknown; webhookSecret?: unknown }): { status: ReturnType<typeof stripeStatus> } | { error: string } {
  if (typeof body.key === "string") {
    if (body.key === "") deleteSecret(APP_VAULT_SCOPE, STRIPE_KEY_NAME);
    else {
      const v = cleanSecret(body.key);
      if (!v) return { error: "stripe_key_invalid" };
      const stored = setSecret(APP_VAULT_SCOPE, STRIPE_KEY_NAME, v);
      if (stored !== true) return stored;
    }
  }
  if (typeof body.webhookSecret === "string") {
    if (body.webhookSecret === "") deleteSecret(APP_VAULT_SCOPE, STRIPE_WEBHOOK_NAME);
    else {
      const v = cleanSecret(body.webhookSecret);
      if (!v) return { error: "stripe_webhook_invalid" };
      const stored = setSecret(APP_VAULT_SCOPE, STRIPE_WEBHOOK_NAME, v);
      if (stored !== true) return stored;
    }
  }
  return { status: stripeStatus() };
}

/** Server side only. Vault value first, then the user's own process env. Straight into the API server's spawn env, nowhere else. */
export function stripeEnvFor(): Record<string, string> {
  const env: Record<string, string> = {};
  const key = resolveSecret(APP_VAULT_SCOPE, STRIPE_KEY_NAME) ?? cleanSecret(process.env.STRIPE_KEY);
  const webhook = resolveSecret(APP_VAULT_SCOPE, STRIPE_WEBHOOK_NAME) ?? cleanSecret(process.env.STRIPE_WEBHOOK_SECRET);
  if (key) env.STRIPE_KEY = key;
  if (webhook) env.STRIPE_WEBHOOK_SECRET = webhook;
  return env;
}

/** "Test key" button: one 1-token request. Returns only the status, never the provider's body. */
export async function testAiKey(project: AppProject): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const env = aiEnvFor(project);
  if (!env.AI_API_KEY) return { ok: false, status: null, error: "ai_not_configured" };
  try {
    const res = await fetch(`${env.AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.AI_API_KEY}` },
      body: JSON.stringify({ model: env.AI_MODEL, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: res.status === 401 || res.status === 403 ? "ai_key_rejected" : "ai_upstream_error" };
  } catch {
    return { ok: false, status: null, error: "ai_unreachable" };
  }
}

/** Reads the app's own ai_usage table (§4.3.8 server/db.mjs). Newest day first. */
export function aiUsage(project: AppProject, days = 30): AppAiUsageDay[] {
  const file = path.join(project.workspaceDir, project.appDir, "data", "app.sqlite");
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_usage'").get();
    if (!exists) return [];
    return db.prepare("SELECT day, calls, tokens FROM ai_usage ORDER BY day DESC LIMIT ?").all(Math.min(Math.max(days, 1), 366)) as unknown as AppAiUsageDay[];
  } finally { db.close(); }
}
