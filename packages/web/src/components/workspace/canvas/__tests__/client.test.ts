/**
 * Neo N2: the canvas HTTP client.
 *
 * The client is a thin boundary over the route, so these tests pin the URL shape
 * (run id and cursor encoded), the auth header, the PATCH body, and the two
 * failure modes the panel turns into a notice: a malformed payload and a
 * non-2xx reply.
 */
import { describe, expect, it, vi } from 'vitest';

import { CanvasClient, canOpenWebpage, canUseNodeActions } from '../client';

const RUN = 'task canvas/1';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const GRAPH = {
  runId: RUN,
  enabled: true,
  nodes: [
    {
      id: 'n1',
      run_id: RUN,
      parent_ids: [],
      type: 'question',
      status: 'finished',
      data: { title: 'Build the site' },
      position: 1,
      version: 1,
      created: 1,
      updated: 1,
      x: 40,
      y: 40,
      depth: 0,
    },
  ],
  edges: [],
  stats: { totalNodes: 1, nodesByType: { question: 1 }, nodesByStatus: { finished: 1 }, depth: 0, edges: 0 },
  fresh: [],
};

describe('canvas client', () => {
  it('requests the graph for a run, encoding the id', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const client = new CanvasClient({
      apiBase: 'http://127.0.0.1:3939',
      headers: () => ({ 'x-loam-install-token': 'tok' }),
      fetchFn: vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, headers: init?.headers as Record<string, string> });
        return jsonResponse(GRAPH);
      }) as unknown as typeof fetch,
    });
    const graph = await client.getGraph(RUN);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:3939/api/graph/${encodeURIComponent(RUN)}`);
    expect(calls[0]!.headers!['x-loam-install-token']).toBe('tok');
    expect(graph.nodes).toHaveLength(1);
    expect(graph.stats.totalNodes).toBe(1);
  });

  it('adds the afterSeq cursor only when one is given', async () => {
    const urls: string[] = [];
    const client = new CanvasClient({
      apiBase: 'http://127.0.0.1:3939',
      fetchFn: vi.fn(async (url: string) => {
        urls.push(String(url));
        return jsonResponse({ ...GRAPH, fresh: [] });
      }) as unknown as typeof fetch,
    });
    await client.getGraph(RUN);
    await client.getGraph(RUN, 7);
    expect(urls[0]).not.toContain('afterSeq');
    expect(urls[1]).toContain('afterSeq=7');
  });

  it('sends a PATCH with the node id encoded and reads the returned node', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new CanvasClient({
      apiBase: 'http://127.0.0.1:3939',
      fetchFn: vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse({ node: { id: 'n 1', run_id: RUN, parent_ids: [], type: 'note', status: 'finished', version: 3 } });
      }) as unknown as typeof fetch,
    });
    const node = await client.patchNode(RUN, 'n 1', { status: 'finished', parentIds: ['root'] });
    expect(calls[0]!.url).toBe(
      `http://127.0.0.1:3939/api/graph/${encodeURIComponent(RUN)}/nodes/${encodeURIComponent('n 1')}`,
    );
    expect(calls[0]!.init!.method).toBe('PATCH');
    expect(calls[0]!.init!.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ status: 'finished', parentIds: ['root'] });
    expect(node.status).toBe('finished');
  });

  it('turns a malformed payload into an error instead of throwing junk', async () => {
    const client = new CanvasClient({
      apiBase: 'http://127.0.0.1:3939',
      fetchFn: vi.fn(async () => jsonResponse({ hello: 'world' })) as unknown as typeof fetch,
    });
    await expect(client.getGraph(RUN)).rejects.toThrow(/malformed canvas graph payload/);
  });

  it('surfaces the server error message for a failed edit', async () => {
    const client = new CanvasClient({
      apiBase: 'http://127.0.0.1:3939',
      fetchFn: vi.fn(async () => jsonResponse({ error: 'node not found in this run' }, 404)) as unknown as typeof fetch,
    });
    await expect(client.patchNode(RUN, 'nope', { status: 'finished' })).rejects.toThrow(
      'node not found in this run',
    );
  });

  it('reports a reply with no node as a save failure', async () => {
    const client = new CanvasClient({
      apiBase: 'http://127.0.0.1:3939',
      fetchFn: vi.fn(async () => jsonResponse({ error: 'illegal run node transition' }, 409)) as unknown as typeof fetch,
    });
    await expect(client.patchNode(RUN, 'n1', { status: 'running' })).rejects.toThrow(
      'illegal run node transition',
    );
  });
});

/**
 * Neo N13: the node-action half of the client.
 *
 * The routes these methods call are exercised end-to-end on the server
 * (`src/server/__tests__/graphNodeRoutes.test.ts`). What has to be pinned here is
 * the *client's* half of the contract: the URL shape for each action, the coercion
 * of the reply into the object the panels render, and the failure modes a panel
 * turns into a sentence rather than a crash.
 */
describe('canvas client node actions', () => {
  const BASE = 'http://127.0.0.1:3939';

  /** A client whose fetch records every call and answers `body`. */
  function clientWith(body: unknown, status = 200) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(body, status);
    }) as unknown as typeof fetch;
    return { client: new CanvasClient({ apiBase: BASE, fetchFn }), calls };
  }

  it('requests a node version history, encoding run and node ids', async () => {
    const { client, calls } = clientWith({
      nodeId: 'doc 1',
      runId: RUN,
      type: 'document',
      current: 2,
      versions: [
        { version: 1, title: 'A', source: 'agent', created: 1, createdAt: 'x', nodeVersion: 1, type: 'document', content: 'one' },
      ],
      files: [],
    });
    const list = await client.getNodeVersions(RUN, 'doc 1');
    expect(calls[0]!.url).toBe(
      `${BASE}/api/graph/${encodeURIComponent(RUN)}/nodes/${encodeURIComponent('doc 1')}/versions`,
    );
    // The reply is coerced, so a panel never renders an undefined title.
    expect(list.versions).toHaveLength(1);
    expect(list.versions[0]).toMatchObject({ version: 1, source: 'agent', content: 'one' });
  });

  it('rejects a version payload with no node id', async () => {
    const { client } = clientWith({ versions: [] });
    await expect(client.getNodeVersions(RUN, 'n1')).rejects.toThrow(/malformed version payload/);
  });

  it('requests a diff between two versions', async () => {
    const { client, calls } = clientWith({
      nodeId: 'n1',
      from: 1,
      to: 3,
      added: 2,
      removed: 1,
      unchanged: 4,
      empty: false,
      lines: [{ op: 'insert', text: 'new', oldLine: null, newLine: 2 }],
    });
    const diff = await client.getNodeDiff(RUN, 'n1', 1, 3);
    expect(calls[0]!.url).toContain('/diff?from=1&to=3');
    expect(diff.lines[0]).toMatchObject({ op: 'insert', newLine: 2, oldLine: null });
  });

  it('lets the server pick the newest version when `to` is omitted', async () => {
    const { client, calls } = clientWith({
      nodeId: 'n1',
      from: 1,
      to: 5,
      added: 0,
      removed: 0,
      unchanged: 3,
      empty: true,
      lines: [],
    });
    await client.getNodeDiff(RUN, 'n1', 1);
    expect(calls[0]!.url).toContain('/diff?from=1');
    expect(calls[0]!.url).not.toContain('to=');
  });

  it('captures a snapshot with a JSON body', async () => {
    const { client, calls } = clientWith({ ok: true, version: 4, versions: [] }, 201);
    const result = await client.captureNodeVersion(RUN, 'n1', 'hand edited');
    expect(calls[0]!.init!.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ content: 'hand edited' });
    expect(result.version).toBe(4);
  });

  it('previews knowledge seeds without writing them', async () => {
    const { client, calls } = clientWith({
      nodeId: 'n1',
      baseName: 'Landing page',
      count: 1,
      seeds: [{ title: 'Hero', body: 'Hello', tags: ['copy'] }],
      warnings: [],
    });
    const preview = await client.previewNodeKnowledge(RUN, 'n1');
    expect(calls[0]!.url).toContain('/knowledge/preview');
    expect(calls[0]!.init?.method ?? 'GET').toBe('GET');
    expect(preview.count).toBe(1);
    expect(preview.seeds[0]).toMatchObject({ title: 'Hero', tags: ['copy'] });
  });

  it('adds a node to a named knowledge base', async () => {
    const { client, calls } = clientWith(
      { ok: true, baseId: 'kb1', baseName: 'Research', smartSplit: true, seeds: [], warnings: [] },
      201,
    );
    await client.addToKnowledgeBase(RUN, 'n1', { baseId: 'kb1', tags: ['copy'] });
    expect(calls[0]!.init!.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ baseId: 'kb1', tags: ['copy'] });
  });

  it('resolves a webpage node artifact', async () => {
    const { client, calls } = clientWith({
      nodeId: 'web 1',
      runId: RUN,
      dir: '/tmp/site',
      entry: 'index.html',
      explicit: true,
      url: '/preview',
      zipUrl: '/artifact.zip',
    });
    const artifact = await client.getNodeArtifact(RUN, 'web 1');
    expect(calls[0]!.url).toContain(`/nodes/${encodeURIComponent('web 1')}/artifact`);
    expect(artifact.entry).toBe('index.html');
    expect(artifact.zipUrl).toBe('/artifact.zip');
  });

  it('starts the sandbox preview for a webpage node', async () => {
    const { client, calls } = clientWith({ url: 'http://127.0.0.1:4100/', root: '/tmp/site' });
    const started = await client.startNodePreview(RUN, 'web 1');
    expect(calls[0]!.url).toContain('/preview');
    expect(started.url).toBe('http://127.0.0.1:4100/');
  });

  it('returns the ZIP as bytes and surfaces a failed download as an error', async () => {
    const zip = new CanvasClient({
      apiBase: BASE,
      fetchFn: (async () => new Response(new Uint8Array([0x50, 0x4b]), { status: 200 })) as unknown as typeof fetch,
    });
    const ok = await zip.downloadNodeZip(RUN, 'web 1');
    // The ZIP arrives as bytes the caller hands to the browser, not as JSON.
    expect(ok.size).toBe(2);

    const failed = new CanvasClient({
      apiBase: BASE,
      fetchFn: (async () => jsonResponse({ error: 'artifact is too large to download' }, 413)) as unknown as typeof fetch,
    });
    await expect(failed.downloadNodeZip(RUN, 'web 1')).rejects.toThrow(
      'artifact is too large to download',
    );
  });

  it('lists the knowledge bases so the sheet can offer a target', async () => {
    const { client } = clientWith({
      bases: [
        { id: 'kb1', name: 'Research', seeds: 4 },
        { id: 'kb2', name: 'Docs', seeds: 0 },
        { id: 'broken' },
      ],
    });
    const bases = await client.listKnowledgeBases();
    // Entries without both an id and a name cannot be offered as a target.
    expect(bases).toEqual([
      { id: 'kb1', name: 'Research', seeds: 4 },
      { id: 'kb2', name: 'Docs', seeds: 0 },
    ]);
  });

  it('treats a node kind as versionable only when the server would allow it', () => {
    expect(canUseNodeActions('document')).toBe(true);
    expect(canUseNodeActions('kb_seed')).toBe(true);
    expect(canUseNodeActions('webpage')).toBe(true);
    expect(canUseNodeActions('question')).toBe(false);
    expect(canUseNodeActions(undefined)).toBe(false);
    expect(canOpenWebpage('webpage')).toBe(true);
    expect(canOpenWebpage('document')).toBe(false);
  });
});
