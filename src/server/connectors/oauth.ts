/**
 * Generic OAuth2 authorization-code + PKCE flow used by Loam connectors.
 *
 * - Client id/secret come ONLY from provider-declared env vars — never
 *   hard-coded, never logged (secretsVault registers values for log redaction).
 * - Tokens are stored ENCRYPTED at rest via the existing secretsVault
 *   (AES-256-GCM machine key), never in the model context or logs.
 * - State (connected/account display) lives in a small JSON file under DATA_DIR;
 *   the account string is sealed in the vault too, so the file holds no PII.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { URLSearchParams } from "node:url";
import { DATA_DIR } from "../../config.js";
import { log } from "../../log.js";
import { setSecret, resolveSecret, deleteSecret } from "../secretsVault.js";
import { BoundedMap } from "../../memory/cache.js";
import { registerCacheStats } from "../../memory/stats.js";

export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Provider-specific query params appended to the authorization URL
   *  (e.g. Google's access_type=offline for refresh-token consent). */
  extraAuthParams?: Record<string, string>;
  /** Exact env var names for the OAuth app credentials. */
  envVars: { clientId: string; clientSecret: string };
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  /** Absolute expiry in epoch ms, when the provider reports one. */
  expiresAt?: number;
}

export interface ConnectorDef {
  id: string;
  name: string;
  oauth: OAuthConfig;
  /** Called once after a successful code exchange to resolve a display account. */
  fetchAccount: (accessToken: string) => Promise<string>;
}

const VAULT_AGENT = "connector";
const TOKEN_SECRET = "tokens";
const ACCOUNT_SECRET = "account";
const STATE_TTL_MS = 10 * 60_000;

function stateFile(): string {
  return path.join(DATA_DIR, "connectors.json");
}

interface ConnectorStateEntry {
  connected: boolean;
  accountSealed?: boolean;
  connectedAt?: string;
}
type ConnectorState = Record<string, ConnectorStateEntry>;

function readState(): ConnectorState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as ConnectorState;
  } catch {
    return {};
  }
}

function writeState(state: ConnectorState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${stateFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), "utf8");
  fs.renameSync(tmp, stateFile());
}

export function connectorEnv(def: ConnectorDef): { clientId: string | undefined; clientSecret: string | undefined } {
  return {
    clientId: process.env[def.oauth.envVars.clientId]?.trim() || undefined,
    clientSecret: process.env[def.oauth.envVars.clientSecret]?.trim() || undefined,
  };
}

export function isConfigured(def: ConnectorDef): boolean {
  const { clientId, clientSecret } = connectorEnv(def);
  return Boolean(clientId && clientSecret);
}

export function isConnected(id: string): boolean {
  return readState()[id]?.connected === true;
}

export function getAccount(id: string): string | null {
  const entry = readState()[id];
  if (!entry?.connected) return null;
  return accountFor(id);
}

function accountFor(id: string): string | null {
  return resolveSecret(`${VAULT_AGENT}-${id}`, ACCOUNT_SECRET);
}

const b64url = (buf: Buffer): string => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

interface PendingFlow {
  def: ConnectorDef;
  verifier: string;
  state: string;
  redirectUri: string;
  createdAt: number;
}
/** In-flight OAuth flows (J6). Each holds a PKCE verifier and state; the map
 *  was unbounded, so an abandoned authorization (user never returns) kept its
 *  entry until the process exited. Bounded LRU plus the existing TTL prune. */
const pending = new BoundedMap<string, PendingFlow>(64, "oauth-pending-flows");
registerCacheStats("oauth-pending-flows", () => pending.stats());

function prunePending(): void {
  const now = Date.now();
  for (const [key, flow] of pending) if (flow.createdAt + STATE_TTL_MS < now) pending.delete(key);
}

/** Build the authorization URL for a connector. The redirect URI must match the
 *  one registered with the provider; callers pass the exact callback URL. */
export function buildAuthUrl(def: ConnectorDef, redirectUri: string): { authUrl: string; state: string } {
  if (!isConfigured(def)) {
    throw new Error(`connector "${def.id}" not configured; set ${def.oauth.envVars.clientId} and ${def.oauth.envVars.clientSecret}`);
  }
  prunePending();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: connectorEnv(def).clientId!,
    redirect_uri: redirectUri,
    scope: def.oauth.scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(def.oauth.extraAuthParams ?? {}),
  });
  pending.set(state, { def, verifier, state, redirectUri, createdAt: Date.now() });
  return { authUrl: `${def.oauth.authorizeUrl}?${params.toString()}`, state };
}

async function postForm(url: string, body: URLSearchParams): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, json };
}

export async function exchangeCode(def: ConnectorDef, params: URLSearchParams, verifier: string, redirectUri: string): Promise<TokenSet> {
  const { clientId, clientSecret } = connectorEnv(def);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.get("code") ?? "",
    client_id: clientId!,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (clientSecret) body.set("client_secret", clientSecret);
  const { status, json } = await postForm(def.oauth.tokenUrl, body);
  if (status !== 200 || typeof json.access_token !== "string") {
    throw new Error(`token exchange failed (${status}): ${String(json.error_description ?? json.error ?? "unknown")}`);
  }
  const tokens: TokenSet = { access_token: json.access_token };
  if (typeof json.refresh_token === "string") tokens.refresh_token = json.refresh_token;
  if (typeof json.token_type === "string") tokens.token_type = json.token_type;
  if (typeof json.expires_in === "number") {
    tokens.expires_in = json.expires_in;
    tokens.expiresAt = Date.now() + json.expires_in * 1000;
  }
  return tokens;
}

/** Validate state, exchange the code, fetch the account, seal tokens in the vault. */
export async function completeCallback(defId: string, params: URLSearchParams): Promise<{ account: string }> {
  prunePending();
  const state = params.get("state") ?? "";
  const flow = pending.get(state);
  if (!flow) throw new Error("invalid or expired OAuth state");
  if (flow.def.id !== defId) throw new Error("OAuth state belongs to a different connector");
  const error = params.get("error");
  if (error) {
    pending.delete(state);
    throw new Error(`provider returned error: ${error}`);
  }
  const code = params.get("code");
  if (!code) throw new Error("missing authorization code");
  const tokens = await exchangeCode(flow.def, params, flow.verifier, flow.redirectUri);
  const account = await flow.def.fetchAccount(tokens.access_token);
  pending.delete(state);
  sealTokens(flow.def.id, tokens);
  const stateMap = readState();
  stateMap[flow.def.id] = { connected: true, accountSealed: true, connectedAt: new Date().toISOString() };
  writeState(stateMap);
  setSecret(`${VAULT_AGENT}-${flow.def.id}`, ACCOUNT_SECRET, account);
  log.info(`connectors: ${flow.def.id} connected as ${maskAccount(account)}`);
  return { account };
}

function maskAccount(account: string): string {
  return account.length > 6 ? `${account.slice(0, 3)}…${account.slice(-3)}` : account;
}

function sealTokens(id: string, tokens: TokenSet): void {
  const sealed = setSecret(`${VAULT_AGENT}-${id}`, TOKEN_SECRET, JSON.stringify(tokens));
  if (sealed !== true) throw new Error(`failed to seal tokens: ${sealed.error}`);
}

function loadTokens(id: string): TokenSet | null {
  const raw = resolveSecret(`${VAULT_AGENT}-${id}`, TOKEN_SECRET);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenSet;
  } catch {
    return null;
  }
}

export async function refreshTokens(def: ConnectorDef, tokens: TokenSet): Promise<TokenSet> {
  if (!tokens.refresh_token) throw new Error("no refresh token available");
  const { clientId, clientSecret } = connectorEnv(def);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: clientId!,
    client_secret: clientSecret!,
  });
  const { status, json } = await postForm(def.oauth.tokenUrl, body);
  if (status !== 200 || typeof json.access_token !== "string") {
    throw new Error(`token refresh failed (${status}): ${String(json.error_description ?? json.error ?? "unknown")}`);
  }
  const next: TokenSet = { access_token: json.access_token, refresh_token: tokens.refresh_token };
  if (typeof json.refresh_token === "string") next.refresh_token = json.refresh_token;
  if (typeof json.token_type === "string") next.token_type = json.token_type;
  if (typeof json.expires_in === "number") {
    next.expires_in = json.expires_in;
    next.expiresAt = Date.now() + json.expires_in * 1000;
  }
  return next;
}

/** Live access token for API calls; refreshes and re-seals when near expiry. */
export async function getAccessToken(def: ConnectorDef): Promise<string> {
  const tokens = loadTokens(def.id);
  if (!tokens) throw new Error(`connector "${def.id}" is not connected`);
  const needsRefresh = tokens.expiresAt !== undefined && tokens.expiresAt - Date.now() < 60_000;
  if (!needsRefresh) return tokens.access_token;
  try {
    const next = await refreshTokens(def, tokens);
    sealTokens(def.id, next);
    return next.access_token;
  } catch (err) {
    throw new Error(`connector "${def.id}" token expired and refresh failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function disconnect(id: string): void {
  deleteSecret(`${VAULT_AGENT}-${id}`, TOKEN_SECRET);
  deleteSecret(`${VAULT_AGENT}-${id}`, ACCOUNT_SECRET);
  const stateMap = readState();
  delete stateMap[id];
  writeState(stateMap);
  log.info(`connectors: ${id} disconnected`);
}

/** Small HTML page shown after the OAuth callback completes. */
export function callbackPage(success: boolean, detail: string): string {
  const title = success ? "Connected" : "Connection failed";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body style="font-family:system-ui;padding:2rem;text-align:center">` +
    `<h2>${title}</h2><p>${escapeHtml(detail)}</p>` +
    `<p style="color:#888;font-size:12px">You can close this window and return to Loam.</p>` +
    `<script>setTimeout(function(){try{window.close()}catch(e){}},3000)</script></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
