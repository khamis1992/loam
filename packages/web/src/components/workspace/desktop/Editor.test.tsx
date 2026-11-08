import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceEditorProps } from '../types';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => '',
  getApiHeaders: async () => ({}),
}));

import DesktopEditor from './Editor';

const props: WorkspaceEditorProps = {
  file: { taskId: 'task_1', path: 'uploads/organizer.desktop.json', name: 'organizer.desktop.json', kind: 'electron-window' },
  live: false,
  onSave: async () => {},
  onChatEdit: () => {},
};

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('desktop workspace editor', () => {
  it('loads metadata by task id and launches and stops the real app', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response({ project: { id: 'app_1', title: 'File organizer', kind: 'electron-app' }, verified: true }))
      .mockResolvedValueOnce(response({ runtime: { pid: 123 } }))
      .mockResolvedValueOnce(response({ stopped: true }));
    render(<DesktopEditor {...props} />);

    expect(await screen.findByRole('heading', { name: 'File organizer' })).toBeInTheDocument();
    expect(screen.getByText(/running locally on this PC/i)).toBeInTheDocument();
    const metadataUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(metadataUrl).toContain('taskId=task_1');
    expect(metadataUrl).toContain('uploads%2Forganizer.desktop.json');

    fireEvent.click(screen.getByRole('button', { name: 'Open desktop app' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('/api/desktop/launch');
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ projectId: 'app_1' }));
    expect(await screen.findByRole('button', { name: 'Stop app' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop app' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe('/api/desktop/stop');
  });

  it('does not launch before verification and reports load failures', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(response({ project: { id: 'app_2', title: 'Unverified app', kind: 'electron-app' }, verified: false }));
    const { unmount } = render(<DesktopEditor {...props} />);
    expect(await screen.findByText('Verification required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open desktop app' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop app' })).toBeDisabled();
    unmount();

    fetchMock.mockResolvedValueOnce(response({ error: 'desktop_metadata_project_mismatch' }, false));
    render(<DesktopEditor {...props} />);
    expect(await screen.findByText('desktop_metadata_project_mismatch')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
