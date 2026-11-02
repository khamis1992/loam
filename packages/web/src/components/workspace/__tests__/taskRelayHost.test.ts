import { describe, expect, it, vi } from 'vitest';
import { workspaceTargetForRelay } from '../TaskRelayHost';
import { CraftRelayClient } from '@/lib/craftRelayClient';

describe('task relay host', () => {
  it('maps an open request onto the matching panel', () => {
    expect(workspaceTargetForRelay('slides', 'deck.pptx')).toEqual({ path: 'deck.pptx', kind: 'craft', craftApp: 'slides' });
    expect(workspaceTargetForRelay('film', null)).toEqual({ path: null, kind: 'loam-video' });
    expect(workspaceTargetForRelay('effects', 'clip.mp4')?.kind).toBe('loam-video');
  });

  it('constructs an observe-only craft client that reports the open request', async () => {
    const opened: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      expect(href).toContain('targets=');
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'workspace_open_request', target: 'slides', path: 'deck.pptx' })}\n\n`));
          controller.close();
        },
      }), { status: 200 });
    });
    const client = new CraftRelayClient({
      taskId: 'task-1',
      observeOnly: true,
      autoReconnect: false,
      apiBase: 'http://127.0.0.1:9',
      headers: () => ({}),
      fetchFn: fetchFn as unknown as typeof fetch,
      onOpenRequest: (request) => opened.push(request.target),
    });
    await client.start();
    await vi.waitFor(() => expect(opened).toEqual(['slides']));
    client.stop();
  });
});
