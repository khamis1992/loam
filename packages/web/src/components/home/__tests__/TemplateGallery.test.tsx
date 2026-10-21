import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TemplateGallery } from '../TemplateGallery';
import { TEMPLATES, type GalleryTemplate } from '../templates';
import { t } from '@/i18n/t';

function findCard(title: string): HTMLElement {
  return screen.getByText(t(title)).closest('button') as HTMLElement;
}

describe('TemplateGallery (#16)', () => {
  it('renders the gallery from the static templates data module', () => {
    render(<TemplateGallery onSelect={() => {}} />);

    expect(screen.getByRole('heading', { name: 'Template gallery' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Search templates...')).toBeTruthy();
    // Beyond the 3 cards on Home: every static template is shown by default.
    for (const tpl of TEMPLATES) {
      expect(screen.getByText(t(tpl.title))).toBeTruthy();
    }
  });

  it('shows template images from the data module on the cards', () => {
    render(<TemplateGallery onSelect={() => {}} />);
    const images = Array.from(document.querySelectorAll('img'));
    expect(images.length).toBe(TEMPLATES.filter((tpl) => tpl.image).length);
    expect(images.some((img) => (img.getAttribute('src') ?? '').startsWith('/templates/'))).toBe(true);
  });

  it('filters by search query (title and prompt)', () => {
    render(<TemplateGallery onSelect={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('Search templates...'), {
      target: { value: 'kanban' },
    });
    expect(screen.getByText('Kanban board')).toBeTruthy();
    expect(screen.queryByText('Habit tracker')).toBeNull();
    expect(screen.queryByText('No results')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('Search templates...'), {
      target: { value: 'zzz-nothing' },
    });
    expect(screen.queryByText('Kanban board')).toBeNull();
    expect(screen.getByText('No results')).toBeTruthy();
  });

  it('filters by category chip', () => {
    render(<TemplateGallery onSelect={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Slides' }));
    expect(screen.getByText('Investor pitch')).toBeTruthy();
    expect(screen.queryByText('Kanban board')).toBeNull();
    // "All" resets the category filter.
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Kanban board')).toBeTruthy();
  });

  it('clicking a card calls onSelect with the template to pre-fill the composer', () => {
    const onSelect = vi.fn();
    render(<TemplateGallery onSelect={onSelect} />);

    fireEvent.click(findCard('Market scan'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const selected: GalleryTemplate = onSelect.mock.calls[0]![0];
    expect(selected.title).toBe('Market scan');
    expect(selected.prompt).toContain('Research a market of my choice');
  });

  it('can render a custom template list instead of the default data', () => {
    const custom: GalleryTemplate[] = [
      { category: 'Docs', title: 'Custom spec', prompt: 'Custom prompt', icon: '📄' },
    ];
    render(<TemplateGallery templates={custom} onSelect={() => {}} />);

    expect(screen.getByText('Custom spec')).toBeTruthy();
    expect(screen.queryByText('Kanban board')).toBeNull();
  });
});
