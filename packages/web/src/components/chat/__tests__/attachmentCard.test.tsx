import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AttachmentCard } from '../AttachmentCard';

describe('AttachmentCard slide preview', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image']))));
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the real slide preview and opens the deck from the card', async () => {
    const onOpen = vi.fn();
    render(<AttachmentCard name="دولة الكويت.pptx" taskId="task-1" path="uploads/deck.pptx" previewPath="previews/slide-1.png" size={1024} onOpen={onOpen} openLabel="Open in Loam Slides" />);
    const image = await screen.findByRole('img', { name: 'دولة الكويت.pptx' });
    expect(image).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('previews%2Fslide-1.png'), expect.any(Object));
    expect(screen.getByText('Slide · 1.0 KB')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open in Loam Slides' })[0]!);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps the compact file row when no preview is available', () => {
    render(<AttachmentCard name="deck.pptx" taskId="task-1" path="uploads/deck.pptx" />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('deck.pptx')).toBeInTheDocument();
  });
});
