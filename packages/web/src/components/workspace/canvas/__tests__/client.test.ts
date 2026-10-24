/**
 * Neo N2: the canvas HTTP client.
 *
 * The client is a thin boundary over the route, so these tests pin the URL shape
 * (run id and cursor encoded), the auth header, the PATCH body, and the two
 * failure modes the panel turns into a notice: a malformed payload and a
 * non-2xx reply.
 */
import { describe, expect, it, vi } from 'vitest';

import { CanvasClient } from '../client';

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

  it('asks the server for a whole-run search with the term encoded', async () => {
    const urls: string[] = [];
    const client = new CanvasClient({
      apiBase: 'http://127.0.0.1:3939',
      fetchFn: vi.fn(async (url: string) => {
        urls.push(String(url));
        return jsonResponse({
          ...GRAPH,
          search: {
            query: 'quarterly',
            hits: [
              {
                nodeId: 'n2',
                nodeType: 'webpage',
                nodeStatus: 'finished',
                title: 'Draft the quarterly report',
                matches: [{ field: 'title', start: 10, length: 9, snippet: 'quarterly' }],
              },
            ],
          },
        });
      }) as unknown as typeof fetch,
    });
    const search = await client.searchGraph('task canvas/1', 'quarterly');
    expect(urls[0]).toBe(`http://127.0.0.1:3939/api/graph/${encodeURIComponent(RUN)}?q=quarterly`);
    expect(search!.query).toBe('quarterly');
    expect(search!.hits.map((hit) => hit.nodeId)).toEqual(['n2']);
    // The hit carries the node id on each match, so the panel can highlight it.
    expect(search!.hits[0]!.matches[0]!.nodeId).toBe('n2');
  });

  it('reports no search for a blank term and for a server that cannot answer', async () => {
    const client = new CanvasClient({
      apiBase: 'http://127.0.0.1:3939',
      fetchFn: vi.fn(async () => jsonResponse({ ...GRAPH })) as unknown as typeof fetch,
    });
    // A blank term is not a question worth asking.
    expect(await client.searchGraph(RUN, '   ')).toBeNull();
    // A reply with no `search` block (a server without the N18 route) is not an error.
    expect(await client.searchGraph(RUN, 'quarterly')).toBeNull();
    // Neither is a non-2xx reply.
    const failing = new CanvasClient({
      apiBase: 'http://127.0.0.1:3939',
      fetchFn: vi.fn(async () => jsonResponse({ error: 'nope' }, 500)) as unknown as typeof fetch,
    });
    expect(await failing.searchGraph(RUN, 'quarterly')).toBeNull();
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
