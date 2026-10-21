import type { GalleryTemplate } from './templates';

/** Lowercase, trim and strip diacritics so Arabic and accented text match plainly. */
export function foldText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/** Unique category list in first-appearance order. */
export function templateCategories(templates: GalleryTemplate[]): string[] {
  const seen = new Set<string>();
  const categories: string[] = [];
  for (const tpl of templates) {
    if (!tpl.category || seen.has(tpl.category)) continue;
    seen.add(tpl.category);
    categories.push(tpl.category);
  }
  return categories;
}

export function matchesSearch(template: GalleryTemplate, query: string): boolean {
  const q = foldText(query.trim());
  if (!q) return true;
  return (
    foldText(template.title).includes(q) ||
    foldText(template.prompt).includes(q) ||
    foldText(template.category).includes(q)
  );
}

export function searchTemplates(templates: GalleryTemplate[], query: string): GalleryTemplate[] {
  if (!query.trim()) return templates;
  return templates.filter((tpl) => matchesSearch(tpl, query));
}

export function filterTemplates(
  templates: GalleryTemplate[],
  opts: { query?: string; category?: string | null } = {},
): GalleryTemplate[] {
  const { query = '', category = null } = opts;
  return templates.filter(
    (tpl) => (!category || tpl.category === category) && matchesSearch(tpl, query),
  );
}
