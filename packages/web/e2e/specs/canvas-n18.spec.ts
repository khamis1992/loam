import { test, expect, type Page, type Route, type WebSocketRoute } from '@playwright/test';

/**
 * Neo N18 acceptance: the canvas controls, driven the way a user drives them.
 *
 * The task asks for "Playwright for each control; search highlights matches". This
 * spec runs the real app in Chromium and mocks only what a desktop bridge and a
 * Loam server would provide: `window.__apis` (auth token), the socket.io stream
 * (so an agent run arrives), and the graph/annotation HTTP surface. No server,
 * database or API key is required, and no model is called.
 *
 * The canvas is reached through the app's own routing rather than by rendering the
 * panel in isolation. The page derives its task id from the first `attachment`
 * event, then `latestWorkspaceDecision` opens the workspace on the Canvas tab for
 * a long-horizon tool with no file output (`browser_goto`), which is the decision
 * a real run makes. The graph is served under that task id, so the mock has to
 * answer for the id the page reports.
 */

const API_BASE = 'http://localhost:8787';
/** The canvas and the annotation layer are served by the Loam server, not the protocol API. */
const LOAM_BASE = 'http://127.0.0.1:3939';
/** The task id the run's attachment event reports; the canvas is keyed by it. */
const TASK_ID = 'task-n18-acceptance';

interface CanvasNodeSeed {
  id: string;
  run_id: string;
  parent_ids: string[];
  type: string;
  status: string;
  data: Record<string, unknown>;
  position: number;
  version: number;
  created: number;
  updated: number;
  x: number;
  y: number;
  depth: number;
}

/** A graph wider and taller than the viewport, so the minimap's viewport rect is visible. */
const GRAPH_SPAN = 1400;

/**
 * A two-node run: a root step and the page it cites. Both titles contain
 * "quarterly", so the search test has a match, and the two differ enough that the
 * highlight can be seen to move between them.
 */
function runNodes(): CanvasNodeSeed[] {
  return [
    {
      id: 'n1',
      run_id: TASK_ID,
      parent_ids: [],
      type: 'recipe_step',
      status: 'running',
      data: { title: 'Gather quarterly sources', stepId: 's1' },
      position: 0,
      version: 1,
      created: 1,
      updated: 1,
      x: 40,
      y: 40,
      depth: 0,
    },
    {
      id: 'n2',
      run_id: TASK_ID,
      parent_ids: ['n1'],
      type: 'webpage',
      status: 'finished',
      data: { title: 'Draft the quarterly report', url: 'https://example.com/report' },
      position: 1,
      version: 1,
      created: 2,
      updated: 3,
      x: 40 + GRAPH_SPAN,
      y: 40 + GRAPH_SPAN,
      depth: 1,
    },
  ];
}

function stats(nodes: CanvasNodeSeed[]) {
  return {
    totalNodes: nodes.length,
    nodesByType: nodes.reduce<Record<string, number>>((acc, node) => {
      acc[node.type] = (acc[node.type] ?? 0) + 1;
      return acc;
    }, {}),
    nodesByStatus: nodes.reduce<Record<string, number>>((acc, node) => {
      acc[node.status] = (acc[node.status] ?? 0) + 1;
      return acc;
    }, {}),
    depth: 1,
    edges: 1,
  };
}

/** The graph payload `GET /api/graph/:runId` serves. */
function graphPayload(nodes: CanvasNodeSeed[]) {
  return {
    runId: TASK_ID,
    enabled: true,
    nodes,
    edges: [{ from: 'n1', to: 'n2' }],
    stats: stats(nodes),
    fresh: [],
  };
}

// Returns `true` so the `return json(...)` lines in `CanvasServer.handle` also
// resolve to "handled": a bare void return would make the caller fulfill again.
async function json(route: Route, body: unknown, status = 200): Promise<boolean> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  return true;
}

interface CanvasCommentSeed {
  id: string;
  author: string;
  text: string;
  created: number;
}

interface CanvasNoteSeed {
  id: string;
  text: string;
  x: number;
  y: number;
  colour: string;
  created: number;
  updated: number;
}

/**
 * The mock Loam server behind the canvas. It owns a real annotation layer, so the
 * panel's writes are echoed back and can be re-read: a tag the user sets is still
 * set after a reload, which is the property the annotations exist for.
 */
class CanvasServer {
  readonly nodes = runNodes();
  readonly tags: Record<string, string> = {};
  readonly comments: Record<string, CanvasCommentSeed[]> = {};
  notes: CanvasNoteSeed[] = [];
  private seq = 0;

  private get annotations() {
    return {
      runId: TASK_ID,
      tags: { ...this.tags },
      comments: JSON.parse(JSON.stringify(this.comments)) as Record<string, CanvasCommentSeed[]>,
      notes: JSON.parse(JSON.stringify(this.notes)) as CanvasNoteSeed[],
    };
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  /** Handle `/api/graph/*` on the Loam base. Returns false when the path is not ours. */
  async handle(route: Route, path: string, method: string): Promise<boolean> {
    // Order mirrors `src/server/routes/graph.ts`: stream, annotations, notes, node
    // annotations, then the graph itself, so a tail is never swallowed by a wider
    // pattern.
    if (/^\/api\/graph\/([^/]+)\/stream$/.test(path)) {
      if (method !== 'GET') return json(route, { error: 'method not allowed' }, 405);
      // The live stream: one snapshot then it stays open, exactly like the server.
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        },
        body: `data: ${JSON.stringify({ type: 'snapshot', runId: TASK_ID, nodes: this.nodes, edges: [{ from: 'n1', to: 'n2' }], stats: stats(this.nodes) })}\n\n`,
      });
      return true;
    }

    if (/^\/api\/graph\/([^/]+)\/annotations$/.test(path)) {
      if (method !== 'GET') return json(route, { error: 'method not allowed' }, 405);
      return json(route, this.annotations);
    }

    const notesMatch = /^\/api\/graph\/([^/]+)\/notes(?:\/([^/]+))?$/.exec(path);
    if (notesMatch) {
      const noteId = notesMatch[2];
      if (method === 'POST' && !noteId) {
        const body = route.request().postDataJSON() as { text?: string; x?: number; y?: number; colour?: string };
        const note: CanvasNoteSeed = {
          id: this.nextId('note'),
          text: typeof body.text === 'string' ? body.text : '',
          x: Number.isFinite(Number(body.x)) ? Number(body.x) : 0,
          y: Number.isFinite(Number(body.y)) ? Number(body.y) : 0,
          colour: typeof body.colour === 'string' ? body.colour : 'none',
          created: Date.now(),
          updated: Date.now(),
        };
        this.notes.push(note);
        return json(route, { note });
      }
      const note = this.notes.find((entry) => entry.id === noteId);
      if (method === 'PATCH') {
        if (!note) return json(route, { error: 'note not found' }, 404);
        const body = route.request().postDataJSON() as { text?: string; x?: number; y?: number; colour?: string };
        if (typeof body.text === 'string') note.text = body.text;
        if (typeof body.colour === 'string') note.colour = body.colour;
        if (Number.isFinite(Number(body.x))) note.x = Number(body.x);
        if (Number.isFinite(Number(body.y))) note.y = Number(body.y);
        note.updated = Date.now();
        return json(route, { note });
      }
      if (method === 'DELETE' && noteId) {
        this.notes = this.notes.filter((entry) => entry.id !== noteId);
        return json(route, { removed: true });
      }
      return json(route, { error: 'method not allowed' }, 405);
    }

    const nodeMatch = /^\/api\/graph\/([^/]+)\/nodes\/([^/]+)\/(colour|comments)(?:\/([^/]+))?$/.exec(path);
    if (nodeMatch) {
      const [, , nodeId, kind, commentId] = nodeMatch;
      const belongs = this.nodes.some((node) => node.id === nodeId);
      if (!belongs) return json(route, { error: 'node not found in this run' }, 404);

      if (kind === 'colour') {
        if (method !== 'PATCH') return json(route, { error: 'method not allowed' }, 405);
        const colour = (route.request().postDataJSON() as { colour?: string }).colour ?? 'none';
        if (colour === 'none') delete this.tags[nodeId];
        else this.tags[nodeId] = colour;
        return json(route, { node: { id: nodeId, run_id: TASK_ID, colour } });
      }
      if (method === 'POST') {
        const { text } = route.request().postDataJSON() as { text?: string };
        const comment: CanvasCommentSeed = { id: this.nextId('c'), author: 'user', text: text ?? '', created: Date.now() };
        this.comments[nodeId] = [...(this.comments[nodeId] ?? []), comment];
        return json(route, { comment });
      }
      if (method === 'DELETE' && commentId) {
        this.comments[nodeId] = (this.comments[nodeId] ?? []).filter((entry) => entry.id !== commentId);
        return json(route, { removed: true });
      }
      return json(route, { error: 'method not allowed' }, 405);
    }

    const graphMatch = /^\/api\/graph\/([^/]+)(?:\/nodes(?:\/([^/]+))?)?$/.exec(path);
    if (!graphMatch) return false;
    const nodeId = graphMatch[2];
    if (method === 'GET' && !nodeId) return json(route, graphPayload(this.nodes));
    if (method === 'PATCH' && nodeId) return json(route, { node: { id: nodeId, run_id: TASK_ID } });
    if (method === 'POST' && nodeId) return json(route, { node: { id: nodeId, run_id: TASK_ID } });
    return json(route, { error: 'method not allowed' }, 405);
  }
}

/**
 * The run the socket replays. The `attachment` event is what gives the page its
 * task id, and the `browser_goto` tool event is what opens the canvas.
 */
function runEvents() {
  const now = Date.now();
  return [
    { id: 'ev-attach', type: 'attachment', timestamp: now, name: 'brief.md', path: '/tmp/brief.md', mime: 'text/markdown', sizeBytes: 10, taskId: TASK_ID },
    { id: 'ev-tool', type: 'toolUsed', timestamp: now, tool: 'browser_goto', actionId: 'act-1', status: 'running', brief: 'Quarterly research', argumentsDetail: { url: 'https://example.com/report' } },
  ];
}

/**
 * Install the desktop bridge, the Loam server mock and the socket mock, then open
 * the task and wait until the canvas is on screen. The returned `server` lets a
 * test assert what the panel wrote.
 */
async function openCanvas(
  page: Page,
  options: {
    preloadedTags?: Record<string, string>;
    preloadedComments?: Record<string, CanvasCommentSeed[]>;
    preloadedNotes?: CanvasNoteSeed[];
  } = {},
) {
  const server = new CanvasServer();
  if (options.preloadedTags) Object.assign(server.tags, options.preloadedTags);
  if (options.preloadedComments) Object.assign(server.comments, options.preloadedComments);
  if (options.preloadedNotes) server.notes.push(...options.preloadedNotes);

  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
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
      // The API stub above is the source of truth.
    }
    // Every base points at this page's own origin, so each call is intercepted by
    // `page.route` below and no request leaves the test. The values are inlined:
    // an init script runs in the page, where this spec's constants do not exist.
    w.__AGENT_STUDIO_ENV__ = { apiBase: 'http://localhost:8787', socketBase: 'http://localhost:8787', loamBase: 'http://127.0.0.1:3939', loamToken: 'e2e-token' };
  });

  // socket.io handshake. The engine sends its own `0` open frame, and the client's
  // namespace packet is `40`; answering with `40{...}` completes it, which is what
  // makes `connect` resolve. The replay rides the client's `join_session` frame.
  await page.routeWebSocket(/.*\/socket\.io\/.*/, (ws: WebSocketRoute) => {
    ws.onMessage((message) => {
      const text = String(message);
      // The client's namespace packet is `40` followed by its auth payload, so this
      // must match on the prefix: an exact `40` comparison never acks the connect.
      if (text.startsWith('40')) {
        ws.send('40{"sid":"e2e-sid"}');
        return;
      }
      if (text === '2') {
        ws.send('3');
        return;
      }
      if (text.includes('join_session')) {
        for (const event of runEvents()) {
          ws.send(`42["message",${JSON.stringify({ id: `frame-${event.id}`, type: 'event', sessionId: 'demo-running', timestamp: Date.now(), event, seq: 1 })}]`);
        }
      }
    });
    ws.send('0{"sid":"e2e-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
  });

  // The protocol API: anything unknown is an empty object, never a 401, so the app
  // never bounces to /login.
  await page.route(`${API_BASE}/**`, (route) => json(route, {}));

  await page.route(`${LOAM_BASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    const handled = await server.handle(route, url.pathname, route.request().method());
    if (!handled) await json(route, {});
  });

  await page.goto('/app/demo-running?draft=Research%20the%20quarterly%20report&mode=standard');

  // The canvas is the whole point: wait for it through the app's own routing.
  await expect(page.getByTestId('canvas-panel')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('canvas-node')).toHaveCount(2, { timeout: 20_000 });
  return server;
}

/** The pan/zoom transform of a node card, which the minimap and cards both follow. */
function nodeTransform(page: Page, nodeId: string) {
  return page.locator(`[data-testid="canvas-node"][data-node-id="${nodeId}"]`).evaluate((el) => el.style.transform);
}

test.describe('N18 canvas controls', () => {
  test('a browser tool event opens the run graph on the Canvas tab', async ({ page }) => {
    await openCanvas(page);

    // Both nodes of the run are on the surface, with their real titles.
    const nodes = page.getByTestId('canvas-node');
    await expect(nodes).toHaveCount(2);
    await expect(nodes.filter({ hasText: 'Gather quarterly sources' })).toBeVisible();
    await expect(nodes.filter({ hasText: 'Draft the quarterly report' })).toBeVisible();
    // The rail counts what the surface shows, so the two views cannot disagree.
    await expect(page.getByTestId('canvas-stats')).toHaveText(/2 nodes/);
    // The canvas is the live surface: it reports the stream it is following.
    await expect(page.getByTestId('canvas-live')).toContainText('Live');
  });

  test('tagging a node paints the card and the edit is served back', async ({ page }) => {
    const server = await openCanvas(page);
    const card = page.getByTestId('canvas-node').filter({ hasText: 'Gather quarterly sources' });

    await expect(card).toHaveAttribute('data-node-tag', 'none');
    await card.getByTestId('canvas-node-tag-blue').click();

    await expect(card).toHaveAttribute('data-node-tag', 'blue');
    // The swatch is a radio group, so the chosen colour is the one that is checked.
    await expect(card.getByTestId('canvas-node-tag-blue')).toHaveAttribute('aria-checked', 'true');
    // The minimap draws the same tag, so thumbnail and cards agree.
    await expect(page.locator('[data-testid="canvas-minimap-node"][data-node-id="n1"]')).toHaveAttribute('data-node-tag', 'blue');
    expect(server.tags.n1).toBe('blue');

    // The layer survives a reload: the annotation is the user's, not a render detail.
    await page.reload();
    await expect(page.getByTestId('canvas-node')).toHaveCount(2, { timeout: 20_000 });
    await expect(page.getByTestId('canvas-node').filter({ hasText: 'Gather quarterly sources' })).toHaveAttribute('data-node-tag', 'blue');
  });

  test('a free note can be added, edited and deleted', async ({ page }) => {
    const server = await openCanvas(page);

    await page.getByTestId('canvas-add-note').click();
    const note = page.getByTestId('canvas-note');
    await expect(note).toBeVisible();
    // A new note opens with placeholder text and is focused, so the user types
    // into it straight away.
    await expect(note).toHaveAttribute('data-note-editing', 'true');
    await expect(note.getByTestId('canvas-note-text')).toHaveValue('New note');
    expect(server.notes).toHaveLength(1);

    // `getAttribute` is async: without the await this is a Promise, and the lookup
    // below would never match the note the server stored.
    const noteId = (await note.getAttribute('data-note-id'))!;
    await note.getByTestId('canvas-note-text').fill('Remember the deadline');
    // The note saves when the caret leaves it, so a keystroke is never a round trip.
    await note.getByTestId('canvas-note-text').blur();

    await expect(page.getByTestId('canvas-notes-item').filter({ hasText: 'Remember the deadline' })).toBeVisible();
    expect(server.notes.find((entry) => entry.id === noteId)?.text).toBe('Remember the deadline');

    await note.getByTestId('canvas-note-delete').click();
    await expect(page.getByTestId('canvas-note')).toHaveCount(0);
    await expect(page.getByTestId('canvas-notes')).toContainText('No notes yet.');
    expect(server.notes).toHaveLength(0);
  });

  test('a comment thread on a node is counted on the card', async ({ page }) => {
    const server = await openCanvas(page);
    const card = page.getByTestId('canvas-node').filter({ hasText: 'Gather quarterly sources' });

    await expect(card.getByTestId('canvas-node-comment-count')).toHaveCount(0);
    await card.click();

    const thread = page.getByTestId('canvas-comments');
    await expect(thread).toContainText('No comments yet.');
    await thread.getByTestId('canvas-comment-input').fill('Looks good');
    await thread.getByTestId('canvas-comment-submit').click();

    await expect(thread.getByText('Looks good')).toBeVisible();
    await expect(card.getByTestId('canvas-node-comment-count')).toHaveText('1');
    expect(server.comments.n1).toHaveLength(1);
  });

  test('search highlights the matching nodes and narrows as the term grows', async ({ page }) => {
    await openCanvas(page);
    const search = page.getByTestId('canvas-search');

    await search.fill('quarterly');
    // Both titles carry the term, so both cards are marked as matches and the rail
    // lists them.
    await expect(page.getByTestId('canvas-search-results')).toContainText('2 matches');
    await expect(page.getByTestId('canvas-search-hit')).toHaveCount(2);
    await expect(page.getByTestId('canvas-node').filter({ hasText: 'Gather quarterly sources' })).toHaveAttribute('data-node-match', 'true');
    await expect(page.getByTestId('canvas-node').filter({ hasText: 'Draft the quarterly report' })).toHaveAttribute('data-node-match', 'true');
    // The minimap marks the same nodes, so the thumbnail and the cards agree.
    await expect(page.getByTestId('canvas-minimap-node').first()).toHaveAttribute('data-node-match', 'true');

    // Narrowing the term drops the root step: its title no longer matches.
    await search.fill('quarterly report');
    await expect(page.getByTestId('canvas-search-results')).toContainText('1 matches');
    await expect(page.getByTestId('canvas-search-hit')).toHaveCount(1);
    await expect(page.getByTestId('canvas-node').filter({ hasText: 'Gather quarterly sources' })).toHaveAttribute('data-node-match', 'false');
    await expect(page.getByTestId('canvas-node').filter({ hasText: 'Draft the quarterly report' })).toHaveAttribute('data-node-match', 'true');

    // The search is case-insensitive, so a capitalised term still matches: both
    // titles carry it, exactly as the lowercase search above did.
    await search.fill('QUARTERLY');
    await expect(page.getByTestId('canvas-search-hit')).toHaveCount(2);

    // A term nothing matches says so instead of showing an empty list.
    await search.fill('zzz');
    await expect(page.getByTestId('canvas-search-results')).toContainText('No matches on this canvas.');
    await expect(page.getByTestId('canvas-search-hit')).toHaveCount(0);
  });

  test('the minimap pans the canvas to where the user aims', async ({ page }) => {
    await openCanvas(page);
    const before = await nodeTransform(page, 'n1');

    // The thumbnail is 168x112 CSS pixels; the click is in its own coordinates.
    const box = (await page.getByTestId('canvas-minimap').boundingBox())!;
    await page.getByTestId('canvas-minimap').click({ position: { x: box.width - 6, y: box.height - 6 } });

    await expect.poll(async () => nodeTransform(page, 'n1')).not.toBe(before);
  });

  test('the keyboard shortcuts drive the canvas without stealing typed text', async ({ page }) => {
    await openCanvas(page);

    await page.keyboard.press('s');
    // The shortcut focuses the search box rather than typing into it.
    await expect(page.getByTestId('canvas-search')).toBeFocused();

    // A keystroke aimed at the search box is text, not the note shortcut.
    await page.getByTestId('canvas-search').fill('quarterly');
    await expect(page.getByTestId('canvas-note')).toHaveCount(0);
    await expect(page.getByTestId('canvas-search')).toHaveValue('quarterly');

    // Escape clears a `type="search"` box but leaves the caret in it, and the panel
    // ignores shortcuts while a field has focus. Blur the box the way a user would
    // by clicking away, so the next shortcut is not swallowed by the search input.
    await page.getByTestId('canvas-search').press('Escape');
    await expect(page.getByTestId('canvas-search')).toHaveValue('');
    await page.getByTestId('canvas-search').blur();

    await page.keyboard.press('n');
    await expect(page.getByTestId('canvas-note')).toBeVisible();

    await page.keyboard.press('?');
    await expect(page.getByTestId('canvas-shortcuts')).toBeVisible();
    await expect(page.getByTestId('canvas-shortcuts')).toContainText('Add a note');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('canvas-shortcuts')).toHaveCount(0);
  });
});
