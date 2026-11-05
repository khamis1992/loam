// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PresentationVideoCard, presentationVideoRequest } from '../PresentationVideoCard';

vi.mock('@/services/rpc', () => ({ getApiBase: () => 'http://localhost', getApiHeaders: async () => ({}) }));

describe('PresentationVideoCard', () => {
  it('starts a real media run with the PPTX and rendered slide paths only on click', async () => {
    const onCreateVideo = vi.fn(async (_request: ReturnType<typeof presentationVideoRequest>) => {});
    render(<PresentationVideoCard taskId="task-1" path="uploads/kuwait.pptx" previewPath="previews/slide-1.png" name="kuwait.pptx" onCreateVideo={onCreateVideo} />);
    expect(onCreateVideo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('make-presentation-video'));
    await waitFor(() => expect(onCreateVideo).toHaveBeenCalledTimes(1));
    const request = onCreateVideo.mock.calls[0]![0];
    expect(request.mode).toBe('standard');
    expect(request.extData).toEqual({ outputType: 'video', loamMode: 'media' });
    expect(request.text).toContain('uploads/kuwait.pptx');
    expect(request.text).toContain('previews/slide-1.png');
    expect(request.text).toContain('Loam Video');
  });

  it('does not submit while the parent task is running', () => {
    const onCreateVideo = vi.fn();
    render(<PresentationVideoCard taskId="task-1" path="uploads/kuwait.pptx" previewPath="previews/slide-1.png" name="kuwait.pptx" disabled onCreateVideo={onCreateVideo} />);
    fireEvent.click(screen.getByTestId('make-presentation-video'));
    expect(onCreateVideo).not.toHaveBeenCalled();
    expect(screen.getByTestId('make-presentation-video')).toBeDisabled();
  });

  it('builds the backend routing fields used by the composer', () => {
    const request = presentationVideoRequest({ path: 'uploads/deck.pptx', previewPath: 'previews/slide-1.png' });
    expect(request.extData.outputType).toBe('video');
    expect(request.extData.loamMode).toBe('media');
  });
});
