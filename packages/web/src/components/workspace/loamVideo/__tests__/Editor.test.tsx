import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceEditorProps } from '../../types';

vi.mock('@/lib/filmcraft', () => {
  class FakeBridge {
    async waitForApi(): Promise<{ hasApi: boolean }> {
      return { hasApi: false };
    }
    dispose(): void {}
    onReady(): () => void {
      return () => {};
    }
  }
  return { FilmcraftBridge: FakeBridge, FILMCRAFT_FRAME_URL: 'loamfilm://app/index.html' };
});

vi.mock('../../video/Editor', () => ({
  default: function LegacyVideoEditorStub() {
    return <div data-testid="legacy-video-editor">Legacy video editor</div>;
  },
}));

vi.mock('../VideoFilePreview', () => ({
  VideoFilePreview: function VideoFilePreviewStub() {
    return <div data-testid="light-video-player">Light video player</div>;
  },
}));

import { Editor } from '../Editor';

const props: WorkspaceEditorProps = {
  file: { taskId: 't1', path: 'clip.mp4', name: 'clip.mp4', kind: 'loam-video' },
  live: false,
  onSave: async () => {},
  onChatEdit: () => {},
};

describe('loam-video workspace editor', () => {
  it('opens a finished video in the lightweight player before starting the advanced studio', async () => {
    render(<Editor {...props} />);
    expect(await screen.findByTestId('light-video-player')).toBeInTheDocument();
    expect(screen.queryByTestId('legacy-video-editor')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Loam Effects')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('open-advanced-video-studio'));
    expect(await screen.findByText(/built-in video editor/i)).toBeInTheDocument();
    expect(await screen.findByTestId('legacy-video-editor')).toBeInTheDocument();
  });
});
