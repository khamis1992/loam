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
    setToken: (token: string) => invoke('auth', 'setToken', [token]),
    removeToken: () => invoke('auth', 'removeToken'),
    notifyLoginSuccess: () => invoke('auth', 'notifyLoginSuccess'),
  },
  system: {
    openExternal: (url: string) => invoke('system', 'openExternal', [url]),
    showFolderDialog: (opts?: { defaultPath?: string }) => invoke('system', 'showFolderDialog', [opts]),
  },
  updater: {
    getStatus: () => invoke('updater', 'getStatus') as Promise<{ state: string; version?: string; progress?: number; error?: string; storeManaged?: boolean; store?: string }>,
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
