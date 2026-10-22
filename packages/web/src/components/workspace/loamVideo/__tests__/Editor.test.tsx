import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceEditorProps } from '../../types';

// The bridge never reports an API, so the panel must fall back to the built-in
// video editor. Both the bridge module and the legacy editor are mocked.
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

import { Editor } from '../Editor';

const props: WorkspaceEditorProps = {
  file: { taskId: 't1', path: 'clip.mp4', name: 'clip.mp4', kind: 'loam-video' },
  live: false,
  onSave: async () => {},
  onChatEdit: () => {},
};

describe('loam-video workspace editor', () => {
  it('falls back to the built-in editor when the bridge is unavailable', async () => {
    render(<Editor {...props} />);
    expect(await screen.findByTestId('legacy-video-editor')).toBeInTheDocument();
    expect(screen.getByText(/built-in video editor/i)).toBeInTheDocument();
  });
});
