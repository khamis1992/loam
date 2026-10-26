/**
 * Cap G §4.16 e2e acceptance: the Agent Studio App Builder surface on a task
 * that owns an App project. Fully offline — every /api call is route-mocked,
 * no model and no Loam server is needed. Asserts the user-visible contract:
 *
 *  1. a task with an App project shows the App Builder header toggle,
 *  2. the workspace drawer opens with all eight tabs,
 *  3. the overview tab shows the project facts,
 *  4. the queue tab renders the live queue from /api/app-projects/:id,
 *  5. the composer Race chip appears, its popover shows the estimate line,
 *     and the send button reads "Send as race" while the chip is on,
 *  6. a raced send hits POST /api/app-projects/:id/runs (engine_pending is
 *     surfaced verbatim — never a fake race start), and the chip turns off,
 *  7. no Sparkles/Star icon renders anywhere on the surface.
 */
import { test, expect, type Page } from '@playwright/test';

const PROJECT = {
  id: 'app_e2etest12345',
  taskId: 'task_e2e_app',
  title: 'تطبيق الاختبار',
  description: 'مشروع e2e',
  templateId: 'web-app',
  features: [],
  workspaceDir: 'C:/tmp/e2e',
  appDir: 'app',
  defaultFlavor: 'quick',
  status: 'idle',
  activeVersion: 2,
  settings: {},
  remixOfProjectId: null,
  remixOfVersion: null,
  depsMode: 'shared',
  ai: { baseUrl: null, model: null, dailyTokenCap: null },
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
};

async function mockApp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__apis = {
      auth: { getToken: () => 'e2e-token', setToken: () => undefined, removeToken: () => undefined, notifyLoginSuccess: () => undefined },
      system: { openExternal: () => undefined },
      theme: { setTheme: () => undefined },
    };
    w.desktopLocalStorage = {
      getItem: (key: string) => (key === 'session_token' ? 'e2e-token' : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    try { window.localStorage.setItem('session_token', 'e2e-token'); } catch {}
    w.__AGENT_STUDIO_ENV__ = { apiBase: 'http://localhost:8787', socketBase: 'http://localhost:8787' };
  });

  await page.routeWebSocket(/.*\/socket\.io\/.*/, (ws) => {
    ws.send('0{"sid":"e2e-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
    ws.onMessage((msg) => { if (String(msg).startsWith('40')) ws.send('40{"sid":"e2e-sid"}'); });
  });
  await page.route('**/user.v1.UserService/UserInfo', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ firstname: 'E2E', lastname: 'User', displayname: 'E2E User', email: 'e2e@example.com' }) }));
  await page.route('**/session.v1.SessionService/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) }));
  await page.route('**/api/sessions/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
  await page.route('**/api/config', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ model: 'm', workspace: 'C:/tmp', modes: [] }) }));

  await page.route('**/api/app-projects?limit=200', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: [PROJECT] }) }));
  await page.route(`**/api/app-projects/${PROJECT.id}`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      project: PROJECT,
      devServer: null,
      queue: { projectId: PROJECT.id, paused: false, items: [{ id: 'pq_e2equeue001', projectId: PROJECT.id, position: 0, content: 'أضف صفحة بحث', flavor: 'quick', attachments: [], status: 'queued', createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z' }] },
    }) }));
  await page.route(`**/api/app-projects/${PROJECT.id}/races/estimate*`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ estimate: { branches: 2, perRunCredits: 10, extraCredits: 12, maxTotalCredits: 30, basis: 'default', sampleRuns: 0 } }) }));
  await page.route(`**/api/app-projects/${PROJECT.id}/runtime-errors*`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ errors: [] }) }));
  await page.route(`**/api/app-projects/${PROJECT.id}/usage*`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: [], totals: { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, toolCalls: 0, durationMs: 0 } }) }));
  await page.route(`**/api/app-projects/${PROJECT.id}/files`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: ['index.html', 'src/App.tsx'], truncated: false }) }));
  await page.route(`**/api/app-projects/${PROJECT.id}/ai`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ config: { keySource: 'none', effective: { baseUrl: '', model: '', hasKey: false }, dailyTokenCap: null } }) }));

  let raceRunHits = 0;
  await page.route(`**/api/app-projects/${PROJECT.id}/runs`, (r) => {
    raceRunHits++;
    return r.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: 'engine_pending', message: 'عملية التشغيل تحتاج محرك البناء' }) });
  });
  return { getRaceRunHits: () => raceRunHits };
}

test.describe('Cap G Agent Studio App Builder', () => {
  test.setTimeout(90_000);
  test('workspace drawer, queue tab, race chip and honest engine_pending send', async ({ page }) => {
    const mocks = await mockApp(page);
    await page.goto('/app/demo-running');

    // The App project binds through the task id an attachment event carries —
    // inject one through the hibernation hook (the view's own event path).
    await page.waitForFunction(
      () => Boolean((window as unknown as { __loamHibernation?: { __attached?: boolean } }).__loamHibernation?.__attached),
      undefined,
      { timeout: 30_000 },
    );
    await page.evaluate((taskId) => {
      (window as unknown as { __loamHibernation: { injectEvents: (id: string, events: unknown[]) => void } })
        .__loamHibernation.injectEvents('demo-running', [
          { id: 'e2e-attach-1', type: 'attachment', timestamp: Date.now(), name: 'brief.md', path: 'C:/tmp/brief.md', mime: 'text/markdown', sizeBytes: 12, taskId },
        ]);
    }, PROJECT.taskId);

    // 1. The header toggle appears (task owns an App project via the clock/attachment taskId).
    const toggle = page.getByTestId('appbuilder-toggle');
    await expect(toggle).toBeVisible({ timeout: 20_000 });

    // 2+3. Drawer opens with all eight tabs; overview shows the project facts.
    await toggle.click();
    const ws = page.getByTestId('appbuilder-workspace');
    await expect(ws).toBeVisible();
    for (const tab of ['نظرة عامة', 'الكونسول', 'الكود', 'الإصدارات', 'الطابور', 'السباق', 'الاستخدام', 'الذكاء']) {
      await expect(ws.getByRole('tab', { name: tab })).toBeVisible();
    }
    await expect(ws.getByText(PROJECT.id)).toBeVisible();

    // 4. Queue tab renders the live queue item.
    await ws.getByRole('tab', { name: 'الطابور' }).click();
    await expect(ws.getByText('أضف صفحة بحث')).toBeVisible();

    // 7. Brand rule: no Sparkles/Star svg glyphs on the surface.
    await expect(ws.locator('svg.lucide-sparkles, svg.lucide-star')).toHaveCount(0);
    // Close the drawer: the raced-send assertions need the composer unobstructed.
    await ws.getByRole('button', { name: 'Close' }).click();
    await expect(ws).toBeHidden();


    // 5. Race chip + popover estimate; send button label flips.
    const chip = page.getByTestId('appbuilder-race-chip');
    await expect(chip).toBeVisible();
    await chip.click();
    const popover = page.getByTestId('appbuilder-race-popover');
    await expect(popover).toBeVisible();
    await expect(popover.getByText('+12 رصيد')).toBeVisible();
    await expect(page.getByTestId('appbuilder-send-as-race')).toBeVisible();

    // 6. Raced send hits the runs endpoint and surfaces engine_pending verbatim;
    //    the chip turns off again after the send.
    await page.locator('textarea').first().fill('ابنِ صفحة رئيسية جديدة');
    await page.getByTestId('appbuilder-send-as-race').click();
    await expect.poll(() => mocks.getRaceRunHits(), { timeout: 10_000 }).toBe(1);
    await expect(page.getByText(/engine_pending/)).toBeVisible();
    await expect(page.getByTestId('appbuilder-race-popover')).toBeHidden();
  });
});
