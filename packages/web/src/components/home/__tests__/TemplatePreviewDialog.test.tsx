import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { APP_TEMPLATE_PREVIEWS, TEMPLATE_PREVIEWS, TemplatePreviewDialog } from '../TemplatePreviewDialog';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  push.mockClear();
});

describe('TemplatePreviewDialog', () => {
  it('plays the anime preview and uses its prompt', () => {
    const template = TEMPLATE_PREVIEWS[0];
    const onUse = vi.fn();
    render(<TemplatePreviewDialog template={template} onClose={vi.fn()} onUse={onUse} />);

    expect(document.querySelector('video')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use this idea' }));
    expect(onUse).toHaveBeenCalledWith(template.prompt);
  });

  it('opens the interactive budget template from the preview', () => {
    const template = TEMPLATE_PREVIEWS[1];
    render(<TemplatePreviewDialog template={template} onClose={vi.fn()} onUse={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open site' }));
    expect(push).toHaveBeenCalledWith('/app/templates/budget');
  });

  it('opens a related app template and its full page', () => {
    const onOpenTemplate = vi.fn();
    const budget = TEMPLATE_PREVIEWS[1];
    const { unmount } = render(<TemplatePreviewDialog template={budget} onClose={vi.fn()} onUse={vi.fn()} onOpenTemplate={onOpenTemplate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Build a focus timer with ambient sounds' }));
    expect(onOpenTemplate).toHaveBeenCalledWith(expect.objectContaining({ id: 'focus-timer' }));
    unmount();

    const focus = APP_TEMPLATE_PREVIEWS.find((item) => item.id === 'focus-timer')!;
    render(<TemplatePreviewDialog template={focus} onClose={vi.fn()} onUse={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open site' }));
    expect(push).toHaveBeenCalledWith('/app/templates/focus-timer');
  });

  it('opens the template gallery from View all', () => {
    render(<TemplatePreviewDialog template={TEMPLATE_PREVIEWS[1]} onClose={vi.fn()} onUse={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'View all' }));
    expect(push).toHaveBeenCalledWith('/app/templates');
  });

  it('navigates the fashion carousel and opens related ideas', () => {
    const template = TEMPLATE_PREVIEWS[2];
    const onUse = vi.fn();
    render(<TemplatePreviewDialog template={template} onClose={vi.fn()} onUse={onUse} />);

    expect(screen.getByText('1 / 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(screen.getByText('2 / 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show image 3' }));
    expect(screen.getByText('3 / 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Visualise interior design concepts for a café' }));
    expect(onUse).toHaveBeenCalledWith('Visualise interior design concepts for a café');
  });
});
