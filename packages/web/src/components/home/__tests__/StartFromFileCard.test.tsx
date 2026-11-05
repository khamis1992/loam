import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StartFromFileCard } from '../StartFromFileCard';
import { desktopApis } from '@/services/desktopApis';

vi.mock('@/services/desktopApis', () => ({
  isDesktop: vi.fn(() => true),
  desktopApis: { system: { showOpenFileDialog: vi.fn() } },
}));

describe('StartFromFileCard', () => {
  beforeEach(() => {
    vi.mocked(desktopApis.system.showOpenFileDialog).mockReset();
  });

  it('defaults to an explicit safe task copy', () => {
    const onFilesAdd = vi.fn();
    const { container } = render(<StartFromFileCard onFilesAdd={onFilesAdd} />);
    const input = container.querySelector('input[type="file"]')!;
    const file = new File(['original'], 'original.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByTestId('local-copy-to-task'));
    expect(onFilesAdd).toHaveBeenCalledWith([file], { mode: 'copy' });
    expect(desktopApis.system.showOpenFileDialog).not.toHaveBeenCalled();
  });

  it('uses the desktop picker for explicit edit-in-place paths', async () => {
    vi.mocked(desktopApis.system.showOpenFileDialog).mockResolvedValue(['C:\\Users\\user\\deck.pptx']);
    const onFilesAdd = vi.fn();
    const { container } = render(<StartFromFileCard onFilesAdd={onFilesAdd} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['deck'], 'deck.pptx')] } });
    fireEvent.click(screen.getByTestId('local-edit-in-place'));
    await waitFor(() => expect(onFilesAdd).toHaveBeenCalledWith([], { mode: 'edit', localFiles: ['C:\\Users\\user\\deck.pptx'] }));
  });
});
