/**
 * Endpoint configuration per BUILD_SPEC §10.5.
 * Values are read through the desktop preload (`desktopSync.env`) so the renderer
 * never reads process.env directly. In a browser/dev context they fall back to
 * `import.meta.env` or sensible defaults.
 */

export interface EnvSnapshot {
  API_BASE: string;
  SOCKET_BASE: string;
  WEB_LOGIN_BASE: string;
  DEEP_LINK_SCHEME: string;
  UPDATE_FEED_URL: string;
  AS_DEBUG_ENDPOINTS: string;
  AS_DEBUG_API_URL?: string;
  AS_DEBUG_SOCKET_URL?: string;
  MOCK_PORT: string;
}

function readBrowserEnv(): Partial<EnvSnapshot> {
  // `import.meta.env` is injected by Vite/Next.js at build time in browser builds.
  try {
    const meta = (import.meta as any).env as Record<string, string> | undefined;
    if (!meta) return {};
    return {
      API_BASE: meta.AS_API_BASE ?? meta.VITE_API_BASE,
      SOCKET_BASE: meta.AS_SOCKET_BASE ?? meta.VITE_SOCKET_BASE,
      WEB_LOGIN_BASE: meta.AS_WEB_LOGIN_BASE ?? meta.VITE_WEB_LOGIN_BASE,
      DEEP_LINK_SCHEME: meta.AS_DEEP_LINK_SCHEME ?? meta.VITE_DEEP_LINK_SCHEME,
      UPDATE_FEED_URL: meta.AS_UPDATE_FEED_URL ?? meta.VITE_UPDATE_FEED_URL,
      AS_DEBUG_ENDPOINTS: meta.AS_DEBUG_ENDPOINTS ?? meta.VITE_DEBUG_ENDPOINTS,
      AS_DEBUG_API_URL: meta.AS_DEBUG_API_URL ?? meta.VITE_DEBUG_API_URL,
      AS_DEBUG_SOCKET_URL: meta.AS_DEBUG_SOCKET_URL ?? meta.VITE_DEBUG_SOCKET_URL,
      MOCK_PORT: meta.MOCK_PORT ?? meta.VITE_MOCK_PORT,
    };
  } catch {
    return {};
  }
}

function getDesktopEnv(): Partial<EnvSnapshot> {
  if (typeof window === 'undefined') return {};
  const sync = (window as any).desktopSync as { env?: Partial<EnvSnapshot> } | undefined;
  return sync?.env ?? {};
}

const browser = readBrowserEnv();
const desktop = getDesktopEnv();

function pick(key: keyof EnvSnapshot, fallback: string): string {
  const value = desktop[key] ?? browser[key];
  if (value !== undefined) return value;
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key] ?? fallback;
  }
  return fallback;
}

export const env = Object.freeze({
  apiBase: pick('API_BASE', 'http://localhost:8787'),
  socketBase: pick('SOCKET_BASE', 'http://localhost:8787'),
  webLoginBase: pick('WEB_LOGIN_BASE', 'http://localhost:8787'),
  deepLinkScheme: pick('DEEP_LINK_SCHEME', 'agentstudio'),
  updateFeedUrl: pick('UPDATE_FEED_URL', ''),
  asDebugEndpoints: pick('AS_DEBUG_ENDPOINTS', '') === '1' || pick('AS_DEBUG_ENDPOINTS', '').toLowerCase() === 'true',
  debugApiUrl: pick('AS_DEBUG_API_URL', ''),
  debugSocketUrl: pick('AS_DEBUG_SOCKET_URL', ''),
  mockPort: Number(pick('MOCK_PORT', '8787')),
});
