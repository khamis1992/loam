import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The panel owns both engines: Loam Video (timeline) and the hidden Loam Effects
 * backend. "Open in effects" hands the selected clip to the effects engine and
 * swaps the visible iframe; "Done" brings the rendered output back.
 *
 * Both bridge modules are mocked so the test exercises the panel's own wiring
 * (which bridge gets which call, and when the engine swaps) without an iframe.
 */

interface FakeFilmBridge {
  inspect: ReturnType<typeof vi.fn>;
  commands: ReturnType<typeof vi.fn>;
  importFiles: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
}

const filmState = {
  selectedClipId: 'clip-1',
  playheadSec: 2,
  sequences: [
    {
      id: 'track-1',
      clips: [
        {
          id: 'clip-1',
          source: 'media/clip.mp4',
          startSec: 0,
          endSec: 4,
          inSec: 1,
          outSec: 3,
          width: 1920,
          height: 1080,
          fps: 30,
        },
      ],
    },
  ],
};

let filmBridge: FakeFilmBridge;
const effectsCall = vi.fn(async (_method: string, ..._args: unknown[]) => ({}));

vi.mock('@/lib/filmcraft', () => ({
  FILMCRAFT_FRAME_URL: 'loamfilm://app/index.html',
  FilmcraftBridge: class FakeFilmcraftBridge {
    async waitForApi(): Promise<{ hasApi: boolean }> {
      return { hasApi: true };
    }
    dispose(): void {}
    onReady(): () => void {
      return () => {};
    }
    async inspect() {
      return filmBridge.inspect();
    }
    async commands() {
      return filmBridge.commands();
    }
    async importFiles(...args: unknown[]) {
      return filmBridge.importFiles(...args);
    }
    async call(method: string, ...args: unknown[]) {
      return filmBridge.call(method, ...args);
    }
  },
}));

vi.mock('@/lib/effectcraft', () => ({
  EFFECTCRAFT_FRAME_URL: 'loameffect://app/index.html',
  EffectcraftBridge: class FakeEffectcraftBridge {
    async waitForApi(): Promise<{ hasApi: boolean }> {
      return { hasApi: true };
    }
    dispose(): void {}
    onReady(): () => void {
      return () => {};
    }
    async call(method: string, ...args: unknown[]) {
      return effectsCall(method, ...args);
    }
    async inspect() {
      return effectsCall('inspect');
    }
    async addFile(...args: unknown[]) {
      return effectsCall('addFile', ...args);
    }
  },
}));

import { LoamVideoPanel } from '../LoamVideoPanel';

describe('LoamVideoPanel effects surface', () => {
  beforeEach(() => {
    filmBridge = {
      inspect: vi.fn(async () => filmState),
      commands: vi.fn(async () => [
        { id: 'timeline.replaceRange' },
        { id: 'importFiles' },
        { id: 'inspect' },
      ]),
      importFiles: vi.fn(async () => ({})),
      call: vi.fn(async () => ({})),
    };
    effectsCall.mockReset();
    effectsCall.mockResolvedValue({ projectPath: 'effects/clip.ecproj' });
  });

  it('labels both engines with Loam names and offers Open in effects', async () => {
    render(<LoamVideoPanel />);
    // The effects engine reports ready, so the button is enabled.
    const open = await screen.findByRole('button', { name: /open in effects/i });
    expect(open).toBeEnabled();
    expect(screen.getByText('Loam Video')).toBeInTheDocument();
    expect(screen.getByText('Loam Effects')).toBeInTheDocument();
    // Upstream engine names must never reach the UI.
    expect(screen.queryByText(/EffectCraft/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/FilmCraft/i)).not.toBeInTheDocument();
  });

  it('hands the selected clip to the effects engine and swaps the visible engine', async () => {
    const onEngineChange = vi.fn();
    const onProjectPathChange = vi.fn();
    render(
      <LoamVideoPanel onEngineChange={onEngineChange} onProjectPathChange={onProjectPathChange} />,
    );
    const open = await screen.findByRole('button', { name: /open in effects/i });
    fireEvent.click(open);

    await waitFor(() => expect(onEngineChange).toHaveBeenCalledWith('effects'));
    // The clip's source and in/out points travel with it, so the effects
    // composition matches the range the user selected on the timeline.
    expect(effectsCall).toHaveBeenCalledWith('addFile', 'media/clip.mp4', 1, 3);
    expect(onProjectPathChange).toHaveBeenCalledWith('effects/clip.ecproj');
    // Now showing the effects engine, the action becomes "Done".
    expect(await screen.findByRole('button', { name: /^done$/i })).toBeInTheDocument();
  });

  it('keeps the timeline state and command catalog in step with the editor', async () => {
    render(<LoamVideoPanel />);
    await screen.findByRole('button', { name: /open in effects/i });
    // inspect() + commands() are read once the video API is up, so "Open in
    // effects" can resolve the clip and the replace command from real ids.
    expect(filmBridge.inspect).toHaveBeenCalled();
    expect(filmBridge.commands).toHaveBeenCalled();
  });
});
