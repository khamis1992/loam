import { useRouter } from 'next/navigation';
import { logout, closeSettings, type AppDispatch } from '@/store';
import { PROTOCOL_API_BASE } from './rpc';
import type { UserInfoResponse } from '@shared/proto';

export interface DesktopSyncInfo {
  platform: string;
  appVersion: string;
  windowId: number;
  locale: string;
  env?: Record<string, string>;
}

function getSync(): DesktopSyncInfo | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as any).desktopSync as DesktopSyncInfo | undefined;
}

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!(window as any).desktopSync;
}

const noOp = (..._args: unknown[]) => Promise.resolve(undefined);
const noOpSync = () => undefined;

export const desktopApis = {
  auth: {
    getToken: () => invoke('auth', 'getToken') as Promise<string | null>,
    setToken: (token: string) => invoke('auth', 'setToken', [token]),
    removeToken: () => invoke('auth', 'removeToken'),
    notifyLoginSuccess: () => invoke('auth', 'notifyLoginSuccess'),
  },
  system: {
    openExternal: (url: string) => invoke('system', 'openExternal', [url]),
    showFolderDialog: (opts?: { defaultPath?: string }) => invoke('system', 'showFolderDialog', [opts]),
    showOpenFileDialog: (opts?: {
      defaultPath?: string;
      filters?: { name: string; extensions: string[] }[];
      multiple?: boolean;
    }) => invoke('system', 'showOpenFileDialog', [opts]) as Promise<string[] | null>,
    readFile: (filePath: string) =>
      invoke('system', 'readFile', [filePath]) as Promise<{ name: string; base64: string; mime: string }>,
  },
  updater: {
    getStatus: () => invoke('updater', 'getStatus') as Promise<{ state: string; version?: string; progress?: number; error?: string; currentVersion?: string; storeManaged?: boolean; store?: string }>,
    checkForUpdates: () => invoke('updater', 'checkForUpdates'),
    restartNow: () => invoke('updater', 'restartNow'),
    getPolicyContext: () => invoke('updater', 'getPolicyContext') as Promise<{ storeManaged?: boolean; channel?: string; platform?: string }>,
  },
  desktopOperator: {
    listWorkspaceDirectory: (path: string) => invoke('desktopOperator', 'listWorkspaceDirectory', [{ path }]) as Promise<{ entries: { name: string; isDir: boolean; size: number }[] }>,
    respondFolderAccess: (req: { requestId: string; decision: 'deny' | 'once' | 'always' }) =>
      invoke('desktopOperator', 'respondFolderAccess', [req]),
  },
  terminal: {
    create: (cwd?: string) => invoke('terminal', 'create', [{ cwd }]) as Promise<{ id: string }>,
    write: (id: string, data: string) => invoke('terminal', 'write', [id, data]),
    resize: (id: string, cols: number, rows: number) => invoke('terminal', 'resize', [id, cols, rows]),
    close: (id: string) => invoke('terminal', 'close', [id]),
  },
};

export const desktopEvents = {
  auth: {
    onLoginSuccess: (cb: () => void) => subscribe('auth', 'onLoginSuccess', cb),
    onLoginError: (cb: (err: { error: string }) => void) => subscribe('auth', 'onLoginError', cb),
  },
  updater: {
    onStatusChanged: (cb: (status: unknown) => void) => subscribe('updater', 'onStatusChanged', cb),
  },
  terminal: {
    onEvent: (cb: (ev: { id: string; kind: string; data?: string; code?: number }) => void) => subscribe('terminal', 'onEvent', cb),
  },
};

export type SessionCheck =
  | { status: 'ok'; user: UserInfoResponse }
  | { status: 'invalid' }
  | { status: 'unreachable' };

/**
 * Validate a session token against the connect API.
 *
 * The result distinguishes a definitive rejection (server answered 401/403 —
 * the token is invalid) from the backend being unreachable (network error /
 * timeout / 5xx). Callers must only clear a PERSISTED token on `invalid`; a
 * transient failure leaves the saved session alone so that a normal boot race
 * (server still starting, network hiccup) can never log the user out.
 */
export async function validateSessionToken(
  token: string,
  opts: { timeoutMs?: number; retries?: number; retryDelayMs?: number } = {},
): Promise<SessionCheck> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const retries = opts.retries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 300;
  let invalid = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${PROTOCOL_API_BASE}/user.v1.UserService/UserInfo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { status: 'ok', user: (await res.json()) as UserInfoResponse };
      // The server understood the request and rejected the token.
      if (res.status === 401 || res.status === 403) { invalid = true; break; }
    } catch {
      /* unreachable/network error — fall through to retry */
    }
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  return invalid ? { status: 'invalid' } : { status: 'unreachable' };
}

export async function logoutAndRedirect(router: ReturnType<typeof useRouter>, dispatch: AppDispatch) {
  await desktopApis.auth.removeToken();
  dispatch(logout());
  dispatch(closeSettings());
  router.replace('/login');
}

function invoke(ns: string, method: string, args: unknown[] = []): Promise<unknown> {
  const apis = (typeof window !== 'undefined' ? (window as any).__apis : undefined) as
    | Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
    | undefined;
  if (apis?.[ns]?.[method]) return apis[ns][method](...args);
  return noOp(...args);
}

function subscribe<T = unknown>(ns: string, event: string, cb: (payload: T) => void): () => void {
  const events = (typeof window !== 'undefined' ? (window as any).__events : undefined) as
    | Record<string, Record<string, <T>(cb: (p: T) => void) => () => void>>
    | undefined;
  if (events?.[ns]?.[event]) return events[ns][event](cb);
  return noOpSync;
}

export { getSync };
