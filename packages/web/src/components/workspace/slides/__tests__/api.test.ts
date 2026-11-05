import { describe, expect, it, vi } from 'vitest';
import { workspaceSlidesFetch } from '../api';

const { getApiHeaders } = vi.hoisted(() => ({ getApiHeaders: vi.fn(async () => ({ 'x-loam-local-token': 'secret' })) }));
vi.mock('@/services/rpc', () => ({ getApiHeaders }));

describe('workspaceSlidesFetch', () => {
  it('sends the local auth token and preserves request headers', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await workspaceSlidesFetch('/api/workspace/slides/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({
      'x-loam-local-token': 'secret',
      'content-type': 'application/json',
    });
  });
});
