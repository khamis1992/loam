import { describe, expect, it } from 'vitest';
import { TEMPLATES, type GalleryTemplate } from '../templates';
import {
  filterTemplates,
  foldText,
  matchesSearch,
  searchTemplates,
  templateCategories,
} from '../templateGalleryFilter';

const make = (title: string, extra: Partial<GalleryTemplate> = {}): GalleryTemplate => ({
  category: 'App',
  title,
  prompt: `Prompt for ${title}`,
  ...extra,
});

describe('templates data module (#16)', () => {
  it('offers a gallery beyond the 3 cards on Home', () => {
    expect(TEMPLATES.length).toBeGreaterThan(3);
  });

  it('gives every template a title and prompt, and a valid optional image path', () => {
    for (const tpl of TEMPLATES) {
      expect(tpl.category.trim()).not.toBe('');
      expect(tpl.title.trim()).not.toBe('');
      expect(tpl.prompt.trim()).not.toBe('');
      if (tpl.image !== undefined) {
        expect(tpl.image.startsWith('/templates/')).toBe(true);
        expect(tpl.image.endsWith('.svg')).toBe(true);
      }
    }
  });

  it('has unique category/title pairs', () => {
    const keys = TEMPLATES.map((tpl) => `${tpl.category}/${tpl.title}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('foldText', () => {
  it('lowercases and strips diacritics', () => {
    expect(foldText('Café')).toBe('cafe');
    expect(foldText('تحوّل')).toBe('تحول');
    expect(foldText('  KANBAN  ')).toBe('kanban');
  });
});

describe('templateCategories', () => {
  it('lists categories in first-appearance order without duplicates', () => {
    const list = [
      make('A', { category: 'Website' }),
      make('B', { category: 'App' }),
      make('C', { category: 'Website' }),
    ];
    expect(templateCategories(list)).toEqual(['Website', 'App']);
  });

  it('covers the eight gallery categories', () => {
    expect(templateCategories(TEMPLATES)).toEqual([
      'Website', 'App', 'Slides', 'Docs', 'Image', 'Video', 'Sheets', 'Research',
    ]);
  });
});

describe('matchesSearch / searchTemplates', () => {
  const list = [
    make('Kanban board', { prompt: 'Drag and drop task cards' }),
    make('Habit tracker', { prompt: 'Weekly habit grid' }),
    make('Pomodoro timer', { category: 'App' }),
  ];

  it('empty or blank search matches everything', () => {
    expect(searchTemplates(list, '')).toHaveLength(3);
    expect(searchTemplates(list, '   ')).toHaveLength(3);
  });

  it('matches titles, prompts and categories ignoring case and diacritics', () => {
    expect(searchTemplates(list, 'kanban')).toEqual([list[0]]);
    expect(searchTemplates(list, 'KANBAN')).toEqual([list[0]]);
    expect(searchTemplates(list, 'habit')).toEqual([list[1]]);
    expect(searchTemplates(list, 'cards')).toEqual([list[0]]);
    // Category text is searchable too: every App-category template matches "app".
    expect(searchTemplates(list, 'app')).toHaveLength(3);
  });

  it('returns [] when nothing matches', () => {
    expect(searchTemplates(list, 'zzz')).toEqual([]);
  });
});

describe('filterTemplates', () => {
  it('combines category and query filters', () => {
    const filtered = filterTemplates(TEMPLATES, { category: 'Website', query: 'landing' });
    expect(filtered.map((tpl) => tpl.title)).toEqual(['Landing page']);
  });

  it('keeps every template when no category and no query are set', () => {
    expect(filterTemplates(TEMPLATES, {})).toHaveLength(TEMPLATES.length);
    expect(filterTemplates(TEMPLATES, { category: null, query: '' })).toHaveLength(TEMPLATES.length);
  });

  it('matchesSearch is reused so a query inside one category narrows it', () => {
    const slides = filterTemplates(TEMPLATES, { category: 'Slides' });
    expect(slides.every((tpl) => tpl.category === 'Slides')).toBe(true);
    expect(filterTemplates(TEMPLATES, { category: 'Slides', query: 'investor' }).map((tpl) => tpl.title))
      .toEqual(['Investor pitch']);
    expect(matchesSearch(TEMPLATES[0]!, 'website') || matchesSearch(TEMPLATES[0]!, 'hero')).toBe(true);
  });
});
