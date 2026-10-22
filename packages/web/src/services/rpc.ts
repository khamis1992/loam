/**
 * Connect JSON RPC client per BUILD_SPEC §8.1.
 *
 * POST {apiBase}/{package}.{Service}/{Method}
 * Headers: Connect-Protocol-Version: 1, Content-Type: application/json,
 *          x-client-id, x-client-type: desktop, x-client-version,
 *          Authorization: Bearer <token>, plus locale/timezone headers.
 */

import type {
  AgentSession,
  DeleteSessionRequest,
  EnsureDeviceIdentityRequest,
  EnsureDeviceIdentityResponse,
  ExchangeTokenByCodeRequest,
  ExchangeTokenByCodeResponse,
  FavoriteSessionRequest,
  GenerateTempAuthCodeResponse,
  GetAvailableCreditsResponse,
  GetSessionRequest,
  GetSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  Project,
  UpdateSessionRequest,
  UserInfoResponse,
} from '@shared/proto';

export const PROTOCOL_API_BASE = 'http://localhost:8787';
const DEFAULT_API_BASE = '/api';

export function getApiBase(): string {
  if (typeof window === 'undefined') return DEFAULT_API_BASE;
  const injected = (window as unknown as { __AGENT_STUDIO_ENV__?: { apiBase?: string } }).__AGENT_STUDIO_ENV__;
  if (injected?.apiBase) return injected.apiBase;
  if ((window as unknown as { __apis?: unknown }).__apis) return PROTOCOL_API_BASE;
  return DEFAULT_API_BASE;
}

const DEFAULT_LOAM_PORT = '3939';

export function getLoamBase(): string {
  if (typeof window === 'undefined') return `http://127.0.0.1:${DEFAULT_LOAM_PORT}`;
  const injected = (window as unknown as { __AGENT_STUDIO_ENV__?: { loamBase?: string } }).__AGENT_STUDIO_ENV__;
  if (injected?.loamBase) return injected.loamBase;
  const sync = (window as unknown as { desktopSync?: { env?: Record<string, string> } }).desktopSync;
  const port = sync?.env?.LOAM_PORT || sync?.env?.MANUS_LOCAL_PORT || DEFAULT_LOAM_PORT;
  return `http://127.0.0.1:${port}`;
}

export function getLoamAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const injected = (window as unknown as { __AGENT_STUDIO_ENV__?: { loamToken?: string } }).__AGENT_STUDIO_ENV__;
  const token = injected?.loamToken || (window as unknown as { desktopSync?: { env?: Record<string, string> } }).desktopSync?.env?.LOAM_LOCAL_TOKEN;
  return token ? { 'x-loam-local-token': token } : {};
}

export async function getSessionToken(): Promise<string> {
  const apis = (typeof window !== 'undefined'
    ? (window as unknown as { __apis?: { auth?: { getToken?: () => Promise<string> } } }).__apis
    : undefined);
  const token = await apis?.auth?.getToken?.();
  if (token) return token;
  // Electron stores the session token in desktopLocalStorage under session_token
  // (written by the main process during deep-link callback), but the auth API
  // returns it only after login. Fall back to storage so nav pages can auth.
  const storage = (typeof window !== 'undefined'
    ? (window as unknown as { desktopLocalStorage?: { getItem?: (key: string) => Promise<string | null> } }).desktopLocalStorage
    : undefined);
  if (storage?.getItem) {
    const stored = await storage.getItem('session_token');
    if (stored) return stored;
  }
  return '';
}

export function handleAuthFailure() {
  if (typeof window === 'undefined') return;
  (window as unknown as { __apis?: { auth?: { removeToken?: () => Promise<unknown> } } }).__apis?.auth?.removeToken?.();
  window.location.href = '/login';
}

/** Return the current session token synchronously from Electron's injected API
 *  or from desktopLocalStorage if available. */
export function getCurrentSessionToken(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const apis = (window as unknown as { __apis?: { auth?: { getToken?: () => string | null | Promise<string | null> } } }).__apis;
  const token = apis?.auth?.getToken?.();
  if (typeof token === 'string' && token) return token;
  return undefined;
}

export async function getApiHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...getLoamAuthHeaders() };
  let token = getCurrentSessionToken();
  if (!token && typeof window !== 'undefined') token = await getSessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export interface RpcError {
  code: string;
  message: string;
  details?: unknown[];
}

export class RpcErrorClass extends Error {
  constructor(public readonly error: RpcError) {
    super(error.message);
    this.name = 'RpcError';
  }
}

export interface RpcClientOptions {
  getToken: () => Promise<string>;
  /** Called when a 401 is received so the caller can clear state. */
  onUnauthorized?: () => void;
  apiBase?: string;
  deviceId?: string;
  clientVersion?: string;
}

export class RpcClient {
  private readonly apiBase: string;
  private readonly deviceId: string;
  private readonly clientVersion: string;

  constructor(private readonly options: RpcClientOptions) {
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.deviceId = options.deviceId ?? 'unknown-device';
    this.clientVersion = options.clientVersion ?? '0.0.0';
  }

  private headers(token: string | undefined): Record<string, string> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offset = -new Date().getTimezoneOffset();
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-client-id': this.deviceId,
      'x-client-type': 'desktop',
      'x-client-version': this.clientVersion,
      'x-client-locale': typeof document !== 'undefined'
        ? document.documentElement.lang
        : 'en',
      'x-client-timezone': tz,
      'x-client-timezone-offset': String(offset),
    };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }

  async call<T>(path: string, body: object = {}, token?: string): Promise<T> {
    const auth = token ?? (await this.options.getToken());
    const url = `${this.apiBase}/${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(auth),
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      (this.options.onUnauthorized ?? handleAuthFailure)();
    }
    const data = (await res.json().catch(() => ({}))) as T | RpcError;
    if (!res.ok) {
      const err = data as RpcError;
      throw new RpcErrorClass({
        code: err.code ?? `http_${res.status}`,
        message: err.message ?? `HTTP ${res.status}`,
        details: err.details,
      });
    }
    return data as T;
  }

  // ---- auth ----
  generateTempAuthCode(loginToken: string) {
    return this.call<GenerateTempAuthCodeResponse>(
      'user.v1.UserAuthService/GenerateTempAuthCode',
      {},
      loginToken,
    );
  }

  exchangeTokenByCode(req: ExchangeTokenByCodeRequest) {
    return this.call<ExchangeTokenByCodeResponse>(
      'user.v1.UserAuthPublicService/ExchangeTokenByCode',
      req,
      '',
    );
  }

  ensureDeviceIdentity(req: EnsureDeviceIdentityRequest) {
    return this.call<EnsureDeviceIdentityResponse>(
      'user.v1.UserAuthService/EnsureDeviceIdentity',
      req,
    );
  }

  userInfo() {
    return this.call<UserInfoResponse>('user.v1.UserService/UserInfo', {});
  }

  getAvailableCredits() {
    return this.call<GetAvailableCreditsResponse>(
      'user.v1.UserService/GetAvailableCredits',
      {},
    );
  }

  logout() {
    return this.call<Record<string, never>>('user.v1.UserAuthService/Logout', {});
  }

  // ---- sessions ----
  listSessions(req: ListSessionsRequest = {}) {
    return this.call<ListSessionsResponse>(
      'session.v1.SessionService/ListSessions',
      req,
    );
  }

  getSession(req: GetSessionRequest) {
    return this.call<GetSessionResponse>(
      'session.v1.SessionService/GetSession',
      req,
    );
  }

  updateSession(req: UpdateSessionRequest) {
    return this.call<Record<string, never>>(
      'session.v1.SessionService/UpdateSession',
      req,
    );
  }

  deleteSession(req: DeleteSessionRequest) {
    return this.call<Record<string, never>>(
      'session.v1.SessionService/DeleteSession',
      req,
    );
  }

  favoriteSession(req: FavoriteSessionRequest) {
    return this.call<Record<string, never>>(
      'session.v1.SessionService/FavoriteSession',
      req,
    );
  }

  unFavoriteSession(req: FavoriteSessionRequest) {
    return this.call<Record<string, never>>(
      'session.v1.SessionService/UnFavoriteSession',
      req,
    );
  }

  archiveSession(req: DeleteSessionRequest) {
    return this.call<Record<string, never>>(
      'session.v1.SessionService/ArchiveSession',
      req,
    );
  }

  unarchiveSession(req: DeleteSessionRequest) {
    return this.call<Record<string, never>>(
      'session.v1.SessionService/UnarchiveSession',
      req,
    );
  }

  updateReadPosition(req: { sessionUid: string; lastReadAt: string }) {
    return this.call<Record<string, never>>(
      'session.v1.SessionService/UpdateReadPosition',
      req,
    );
  }

  listSessionFiles(req: { sessionId: string; offset?: number; limit?: number }) {
    return this.call<{ files: unknown[]; total: string }>(
      'session.v1.SessionService/ListSessionFiles',
      req,
    );
  }

  // ---- projects ----
  listProjects(req: { limit?: number; offset?: number } = {}) {
    return this.call<{ projects: Project[]; hasNext: boolean; total: string }>(
      'session.v1.ProjectService/ListProjects',
      req,
    );
  }

  createProject(req: Partial<Project>) {
    return this.call<Project>('session.v1.ProjectService/CreateProject', req as Record<string, unknown>);
  }

  updateProject(req: Partial<Project> & { uid: string }) {
    return this.call<Project>('session.v1.ProjectService/UpdateProject', req as Record<string, unknown>);
  }

  deleteProject(req: { uid: string }) {
    return this.call<Record<string, never>>(
      'session.v1.ProjectService/DeleteProject',
      req,
    );
  }

  // ---- desktop ----
  getDesktopDevices() {
    return this.call<{ devices: unknown[] }>('desktop.v1.DesktopService/GetDesktopDevices', {});
  }
}
