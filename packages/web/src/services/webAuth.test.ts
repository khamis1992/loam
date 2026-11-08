import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopApis } from './desktopApis';
import { getCurrentSessionToken, getSessionToken } from './rpc';
import { readWebSessionToken, webLocalSignIn } from './webAuth';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('browser session authentication', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/login?from=web')) return json({ token: 'login-token' });
      if (url.endsWith('/GenerateTempAuthCode')) return json({ token: 'temp-code' });
      if (url.endsWith('/ExchangeTokenByCode')) return json({ token: 'session-token' });
      return json({ error: 'not found' }, 404);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, '__apis');
    Reflect.deleteProperty(window, 'desktopSync');
    Reflect.deleteProperty(window, '__AGENT_STUDIO_ENV__');
    window.localStorage.clear();
  });

  it('completes the local login chain and persists the session', async () => {
    await expect(webLocalSignIn('http://loam.test')).resolves.toBe(true);
    expect(readWebSessionToken()).toBe('session-token');
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(getSessionToken()).resolves.toBe('session-token');
    expect(getCurrentSessionToken()).toBe('session-token');
  });

  it('does not persist a session when the exchange fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unavailable' }, 503)));
    await expect(webLocalSignIn('http://loam.test')).resolves.toBe(false);
    expect(readWebSessionToken()).toBe('');
  });

  it('uses the browser fallback through the shared desktop API surface', async () => {
    (window as unknown as { __AGENT_STUDIO_ENV__: { apiBase: string } }).__AGENT_STUDIO_ENV__ = { apiBase: 'http://loam.test' };
    await expect(desktopApis.auth.localSignIn()).resolves.toBe(true);
    await expect(desktopApis.auth.getToken()).resolves.toBe('session-token');
    await desktopApis.auth.removeToken();
    expect(readWebSessionToken()).toBe('');
  });

  it('keeps native Electron authentication ahead of browser storage', async () => {
    window.localStorage.setItem('agent-studio:session-token', 'web-token');
    const getToken = vi.fn(async () => 'native-token');
    const localSignIn = vi.fn(async () => true);
    (window as unknown as { __apis: unknown }).__apis = { auth: { getToken, localSignIn } };
    (window as unknown as { desktopSync: unknown }).desktopSync = {};

    await expect(desktopApis.auth.getToken()).resolves.toBe('native-token');
    await expect(desktopApis.auth.localSignIn()).resolves.toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(readWebSessionToken()).toBe('web-token');
  });
});
