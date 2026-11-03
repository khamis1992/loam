import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDocTrack, saveDocTrack } from '../trackSidecar';
import type { WorkspaceFile } from '../../types';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => '',
  getApiHeaders: async () => ({ 'x-test': '1' }),
}));

const file: WorkspaceFile = { taskId: 'task_abc', path: 'docs/تقرير.docx', name: 'تقرير.docx', kind: 'doc' };
const trackUrl = '/api/workspace/doc/track?taskId=task_abc&path=docs%2F%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.docx';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('track sidecar api', () => {
  it('GETs the sidecar URL and unwraps { track }', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ track: { paragraphs: [] } }) });
    const track = await loadDocTrack(file);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(trackUrl, { headers: { 'x-test': '1' } });
    expect(track).toEqual({ paragraphs: [] });
  });

  it('returns null when the server has no sidecar', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ track: null }) });
    expect(await loadDocTrack(file)).toBeNull();
  });

  it('surfaces server errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'track.paragraphs must be an array' }) });
    await expect(loadDocTrack(file)).rejects.toThrow('track.paragraphs must be an array');
  });

  it('PUTs the serialized model as JSON', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    const track = { authors: {}, paragraphs: [], threads: [] } as unknown as Parameters<typeof saveDocTrack>[1];
    await saveDocTrack(file, track);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(trackUrl, {
      method: 'PUT',
      headers: { 'x-test': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ track }),
    });
  });
});
