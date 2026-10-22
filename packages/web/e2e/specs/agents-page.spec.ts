import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Agents page end-to-end coverage.
 *
 * The app normally runs inside the Electron shell, which injects `window.__apis`
 * (auth token) and `window.__AGENT_STUDIO_ENV__` (API/socket base). These specs
 * reproduce that bridge in a plain Chromium page and mock every backend call
 * with `page.route`, so no server, database or API key is required.
 */

const API_BASE = 'http://localhost:8787';

interface MockAgent {
  id: string;
  name: string;
  emoji?: string;
  description?: string;
  pinnedAt?: number;
  sortOrder?: number;
}

const INITIAL_AGENTS: MockAgent[] = [
  { id: 'a-ar', name: 'مساعد البحث', emoji: '🔎', description: 'وكيل عربي للبحث' },
  { id: 'a-en', name: 'Researcher', emoji: '🔬', description: 'Finds primary sources' },
];

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * Installs the desktop bridge and a stateful API mock. The returned `agents`
 * array is mutated by pin/unpin so a re-fetch after the action reflects it.
 */
async function mockBackend(page: Page, initial: MockAgent[]): Promise<MockAgent[]> {
  const agents: MockAgent[] = initial.map((a) => ({ ...a }));

  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    // Mirror the Electron preload: auth.getToken is synchronous and the session
    // token is also mirrored into desktopLocalStorage under "session_token"
    // (services/rpc.ts reads that fallback when __apis is absent).
    w.__apis = {
      auth: {
        getToken: () => 'e2e-token',
        setToken: () => undefined,
        removeToken: () => undefined,
        notifyLoginSuccess: () => undefined,
      },
      system: { openExternal: () => undefined },
      theme: { setTheme: () => undefined },
    };
    w.desktopLocalStorage = {
      getItem: (key: string) => (key === 'session_token' ? 'e2e-token' : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    try {
      window.localStorage.setItem('session_token', 'e2e-token');
    } catch {
      // The API stub above is the source of truth; ignore unavailable storage.
    }
    w.__AGENT_STUDIO_ENV__ = { apiBase: 'http://localhost:8787', socketBase: 'http://localhost:8787' };
  });

  await page.routeWebSocket(/.*\/socket\.io\/.*/, (ws) => {
    ws.send('0{"sid":"e2e-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
    ws.send('40');
  });

  // Catch-all for the desktop protocol base (lowest priority: registered first
  // so the specific handlers below win). The real backend on :8787 answers 401
  // for unauthenticated RPC calls (e.g. ListSessions), and any 401 makes the
  // app bounce to /login.
  await page.route('http://localhost:8787/**', (route) => json(route, {}));

  // Exact session-validation endpoint the layout calls before rendering
  // (desktopApis.validateSessionToken -> POST /user.v1.UserService/UserInfo).
  await page.route('**/user.v1.UserService/UserInfo', (route) =>
    json(route, { firstname: 'E2E', lastname: 'User', displayname: 'E2E User', email: 'e2e@example.com', avatar: null }),
  );

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const body = (): Record<string, unknown> => {
      try {
        return (route.request().postDataJSON() as Record<string, unknown>) ?? {};
      } catch {
        return {};
      }
    };

    if (path === '/api/agents' && method === 'GET') return json(route, { agents });
    if (path === '/api/agents/reorder' && method === 'POST') return json(route, { pinned: [], agents });
    if (/^\/api\/agents\/[^/]+\/pin$/.test(path) && method === 'POST') {
      const id = decodeURIComponent(path.split('/')[3]);
      const agent = agents.find((a) => a.id === id);
      if (agent) {
        if (body().pinned) agent.pinnedAt = Date.now();
        else delete agent.pinnedAt;
      }
      return json(route, { agent });
    }
    if (/^\/api\/agents\/[^/]+\/thread$/.test(path) && method === 'GET') {
      return json(route, { item: { threadUid: 'thr-1' } });
    }
    if (/^\/api\/agents\/[^/]+\/thread\/seen$/.test(path)) return json(route, { ok: true });
    if (/^\/api\/agents\/[^/]+\/children$/.test(path)) return json(route, { children: [] });
    if (/^\/api\/agents\/[^/]+\/(memory|scratchpad|watches|schedules|channels)$/.test(path)) return json(route, {});
    if (path === '/api/groups') return json(route, { groups: [] });
    if (path === '/api/agent-threads') return json(route, { threads: [] });
    if (path === '/api/approval-rules') return json(route, { rules: [] });
    if (path === '/api/channels') return json(route, { channels: [] });
    if (path === '/api/swarm/runs') return json(route, { runs: [] });
    if (path === '/api/tasks') return json(route, { tasks: [] });
    if (/^\/api\/tasks\/thr-1/.test(path)) {
      return json(route, {
        task: { messages: [{ role: 'user', content: 'Hello from the thread', at: new Date().toISOString() }] },
      });
    }
    if (/^\/api\/tasks\/thr-1\/files$/.test(path)) return json(route, { files: [] });
    if (path === '/api/bridge/grokbot/mirror') return json(route, { messages: [] });
    if (path === '/api/live-view/status') {
      return json(route, { available: false, screen: { available: false, running: false }, browser: { available: false, url: null } });
    }
    if (path === '/api/live-view/frame') return json(route, { frame: null });
    return json(route, {});
  });

  return agents;
}

test.describe('agents page', () => {
  test('renders the agents list from the API', async ({ page }) => {
    await mockBackend(page, INITIAL_AGENTS);
    await page.goto('/app/agents');

    await expect(page.getByText('مساعد البحث', { exact: true })).toBeVisible();
    await expect(page.getByText('Researcher', { exact: true })).toBeVisible();
    await expect(page.getByText('My agents', { exact: true })).toBeVisible();
  });

  test('search filters by Arabic and English names', async ({ page }) => {
    await mockBackend(page, INITIAL_AGENTS);
    await page.goto('/app/agents');

    // The search field is toggled by the header search icon (Grok Bot parity).
    await page.getByRole('button', { name: 'Search agents' }).click();

    const search = page.getByPlaceholder('Search agents');
    await expect(search).toBeVisible();

    await search.fill('مساعد');
    await expect(page.getByText('مساعد البحث', { exact: true })).toBeVisible();
    await expect(page.getByText('Researcher', { exact: true })).toHaveCount(0);

    await search.fill('research');
    await expect(page.getByText('Researcher', { exact: true })).toBeVisible();
    await expect(page.getByText('مساعد البحث', { exact: true })).toHaveCount(0);
  });

  test('pin moves an agent to the pinned section and unpin moves it back', async ({ page }) => {
    await mockBackend(page, INITIAL_AGENTS);
    await page.goto('/app/agents');

    const row = page.locator('main').getByRole('button', { name: /Researcher/ }).first();
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });
    await page.getByRole('button', { name: 'Pin', exact: true }).click();

    const pinned = page.locator('[data-agents-section="pinned"]');
    await expect(pinned.getByText('Researcher', { exact: true })).toBeVisible();
    await expect(page.locator('[data-agents-section="my-agents"]').getByText('Researcher', { exact: true })).toHaveCount(0);

    const pinnedRow = page.getByRole('button', { name: /Pinned agent Researcher/ });
    await pinnedRow.click({ button: 'right' });
    await page.getByRole('button', { name: 'Unpin', exact: true }).click();

    await expect(page.locator('[data-agents-section="my-agents"]').getByText('Researcher', { exact: true })).toBeVisible();
    await expect(page.locator('[data-agents-section="pinned"]')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/agents-page.png', fullPage: true });
  });

  test('opening an agent shows the thread and Ctrl+Shift+I toggles the info pane', async ({ page }) => {
    await mockBackend(page, INITIAL_AGENTS);
    await page.goto('/app/agents');

    await page.locator('main').getByRole('button', { name: /Researcher/ }).first().click();

    // Thread view: the centered header pill toggles the info pane.
    const toggle = page.getByRole('button', { name: 'Agent info' });
    await expect(toggle).toBeVisible();
    await expect(page.getByText('Hello from the thread')).toBeVisible();

    // Info pane starts closed; the Channels heading is unique to the pane.
    await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toHaveCount(0);

    await page.keyboard.press('Control+Shift+I');
    await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();

    await page.keyboard.press('Control+Shift+I');
    await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toHaveCount(0);
  });

  test('Arabic locale renders real Arabic without mojibake', async ({ page }) => {
    await mockBackend(page, INITIAL_AGENTS);
    await page.addInitScript(() => {
      (window as unknown as { __FORCE_LOCALE__?: string }).__FORCE_LOCALE__ = 'ar';
    });
    await page.goto('/app/agents');

    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // Sidebar header is t('Agents') -> "الوكلاء" in the Arabic catalog.
    await expect(page.getByText('الوكلاء', { exact: true })).toBeVisible();

    const text = await page.locator('body').innerText();
    expect(/[\u0600-\u06FF]/.test(text)).toBe(true);
    // Mojibake shows up as stray Latin-1 accented characters (e.g. "Ã", "Â").
    expect(/[\u00C0-\u00FF]/.test(text)).toBe(false);
  });
});
