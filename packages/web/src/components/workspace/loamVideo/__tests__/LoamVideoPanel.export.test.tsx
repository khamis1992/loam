/**
 * fc-06 — the Loam Video panel's Export button.
 *
 * The panel only talks to the browser half of the export (`exportLoamVideo` in
 * @/lib/videoStudioExport). The render itself runs in the server service, which
 * is covered by src/server/__tests__/videoStudioExport.test.ts. Here we assert the
 * panel's own contract: the button is gated on a task and a ready editor, it
 * shows progress while rendering, it reports the saved file on success and the
 * server's error on failure, and it never writes anything itself.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LoamVideoExportProgress, LoamVideoExportResult } from '@/lib/videoStudioExport';

const exportLoamVideo = vi.fn();

vi.mock('@/lib/videoStudioExport', () => ({
  exportLoamVideo: (options: unknown) => exportLoamVideo(options),
}));

vi.mock('@/lib/filmcraft', () => {
  class FakeBridge {
    async waitForApi(): Promise<{ hasApi: boolean }> {
      return { hasApi: true };
    }
    dispose(): void {}
    onReady(): () => void {
      return () => {};
    }
    async importFiles(): Promise<void> {}
  }
  return { FilmcraftBridge: FakeBridge, FILMCRAFT_FRAME_URL: 'loamfilm://app/index.html' };
});

vi.mock('@/lib/filmcraftClient', () => ({
  setLoamVideoTarget: vi.fn(),
}));

import { LoamVideoPanel } from '../LoamVideoPanel';

const success: LoamVideoExportResult = {
  ok: true,
  path: 'exports/loam-cut.mp4',
  name: 'loam-cut.mp4',
  mime: 'video/mp4',
  bytes: 2048,
  command: 'file.exportMedia',
};

describe('LoamVideoPanel export button', () => {
  it('stays hidden on the standalone /app/video page (no task to save into)', async () => {
    render(<LoamVideoPanel />);
    // The bridge resolves asynchronously; let it settle before asserting.
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());
    expect(screen.queryByTestId('loam-video-export')).not.toBeInTheDocument();
  });

  it('renders, disables, then reports the saved file on success', async () => {
    exportLoamVideo.mockImplementation(
      async (_options: unknown, onProgress?: (p: LoamVideoExportProgress) => void) => {
        onProgress?.({ stage: 'starting' });
        onProgress?.({ stage: 'rendering', progress: 0.5 });
        return success;
      },
    );

    render(<LoamVideoPanel taskId="task_1" />);
    const button = await screen.findByTestId('loam-video-export');

    // The editor must be ready before the button can drive an export.
    await waitFor(() => expect(button).not.toBeDisabled());

    act(() => {
      button.click();
    });

    expect(await screen.findByText(/loam-cut\.mp4/)).toBeInTheDocument();
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
    expect(exportLoamVideo).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task_1', options: { format: 'mp4' } }),
    );
  });

  it('surfaces the server error instead of claiming success', async () => {
    exportLoamVideo.mockRejectedValue(new Error('the Loam Video editor refused the command'));

    render(<LoamVideoPanel taskId="task_1" />);
    const button = await screen.findByTestId('loam-video-export');
    await waitFor(() => expect(button).not.toBeDisabled());

    act(() => {
      button.click();
    });

    expect(await screen.findByText(/editor refused the command/)).toBeInTheDocument();
    expect(screen.queryByText(/loam-cut\.mp4/)).not.toBeInTheDocument();
  });
});
