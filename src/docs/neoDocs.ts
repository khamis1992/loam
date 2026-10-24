/**
 * Neo N22 - the docs build.
 *
 * `docs/neo/*.md` is the long-horizon user guide: Canvas, Recipe, Knowledge
 * Garden and Missions, in English and Arabic. This module turns those files
 * into the single thing every consumer reads - a manifest of pages, each with
 * its Markdown body, its locale and its cross-links - so that
 *
 *   - the in-app help route can render the guide without a markdown dependency,
 *   - `src/scripts/check-docs-links.ts` can prove every link resolves,
 *   - `src/scripts/check-docs-links.test.ts` can assert both of the above.
 *
 * The guide is deliberately plain Markdown (headings, paragraphs, lists, tables,
 * links, `code`). The renderer in `docsHtml` covers exactly that subset, which
 * keeps the build dependency-free and the output inspectable in a diff. It is
 * not a general Markdown engine, and it says so: an unrecognised block is
 * emitted as a paragraph rather than dropped.
 *
 * Kept free of React and of the i18n catalog so it can run under `node --test`.
 */
import { headingAnchor } from './headingAnchors.js';

/** One page of the guide. */
export interface NeoDocPage {
  /** File name inside `docs/neo`, e.g. `canvas.md`. */
  file: string;
  /** `en` or `ar`. */
  locale: Locale;
  /** The page title, taken from its first `# ` heading. */
  title: string;
  /** All `## ` headings, in order. Used to cross-check EN/AR structure. */
  sections: string[];
  /** Lower-cased anchors of `sections`, in the order they appear. */
  anchors: string[];
  /** The Markdown body, headings included. */
  body: string;
  /** `Related:` links from the page's cross-reference line, if it has one. */
  related: string[];
}

export type Locale = 'en' | 'ar';

/** Every page of the guide, in the order they are listed in the index. */
export const NEO_DOC_FILES = [
  'README.md',
  'canvas.md',
  'recipe.md',
  'knowledge-garden.md',
  'missions.md',
] as const;

export type NeoDocFile = (typeof NEO_DOC_FILES)[number];

/** The Arabic counterpart of an English page, or `null` for the index pair. */
export function arabicFileOf(file: string): string | null {
  if (file === 'README.md') return 'README.ar.md';
  return file.replace(/\.md$/, '.ar.md');
}

/** The English counterpart of an Arabic page. */
export function englishFileOf(file: string): string {
  return file.replace(/\.ar\.md$/, '.md');
}

/** Read the locale off the file name: `*.ar.md` is Arabic, everything else English. */
export function localeOf(file: string): Locale {
  return file.endsWith('.ar.md') ? 'ar' : 'en';
}

/** Lower-cased `docs/neo` file name for a page, used in build errors. */
export function docDirName(): string {
  return 'docs/neo';
}

/** The headings of a Markdown body, `## ` and deeper, in order. */
export function docSections(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    out.push(match[2]!.trim());
  }
  return out;
}

/** The `# ` title of a page, or `''` when it has none. */
export function docTitle(body: string): string {
  for (const line of body.split('\n')) {
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) return match[1]!.trim();
  }
  return '';
}

/**
 * The `Related:` cross-reference line: `Related: [a](a.md) · [b](b.md)`.
 * Returns the link targets only, in order, so the checker can verify them
 * without caring how the line was punctuated.
 */
export function docRelated(body: string): string[] {
  const line = body
    .split('\n')
    .find((l) => /^\s*(related|مرتبط)\s*:/i.test(l));
  if (!line) return [];
  return [...line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]!);
}

/** All Markdown link targets in a body, inline and reference-style, in order. */
export function docLinks(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    out.push(match[1]!);
  }
  for (const match of body.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) {
    out.push(match[1]!);
  }
  return out;
}

/** True when a link target is a bare fragment (`#section`), which never names a file. */
export function isFragmentOnly(target: string): boolean {
  return target.startsWith('#');
}

/** True when a link target is external or a pure fragment. */
export function isExternalLink(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

/** Strip a fragment and a query from a link target, for local file lookups. */
export function linkPath(target: string): string {
  return target.split('#')[0]!.split('?')[0]!;
}

/**
 * Every fragment link in a body, paired with the file it should resolve in.
 * A target with no `#` is not a fragment link, so it is skipped.
 */
export function docFragmentLinks(body: string): { target: string; fragment: string }[] {
  const out: { target: string; fragment: string }[] = [];
  for (const target of docLinks(body)) {
    const hash = target.indexOf('#');
    if (hash === -1) continue;
    out.push({ target, fragment: target.slice(hash + 1) });
  }
  return out;
}

/** A parsed guide: every page, plus the index order. */
export interface NeoDocsManifest {
  /** Absolute path of `docs/neo`. */
  dir: string;
  /** Pages keyed by file name, in `NEO_DOC_FILES` order (English then Arabic). */
  pages: NeoDocPage[];
  /** File names in manifest order. */
  files: string[];
  /** File names that are missing from disk. */
  missing: string[];
}

/**
 * Parse a guide from already-read file contents.
 *
 * `readFile(file)` is injected rather than called directly so the tests can
 * point the same code at a fixture directory, and so the build never needs a
 * filesystem of its own in a unit test.
 */
export function buildNeoDocs(
  dir: string,
  readFile: (file: string) => string | null,
): NeoDocsManifest {
  const files: string[] = [];
  const missing: string[] = [];
  const pages: NeoDocPage[] = [];

  for (const file of NEO_DOC_FILES) {
    const arabic = arabicFileOf(file);
    for (const candidate of arabic ? [file, arabic] : [file]) {
      const body = readFile(candidate);
      if (body === null) {
        missing.push(candidate);
        continue;
      }
      files.push(candidate);
      const sections = docSections(body);
      pages.push({
        file: candidate,
        locale: localeOf(candidate),
        title: docTitle(body),
        sections,
        anchors: sections.map(headingAnchor),
        body,
        related: docRelated(body),
      });
    }
  }

  return { dir, pages, files, missing };
}

/** The English and Arabic pages that describe the same subject. */
export function localePairs(pages: NeoDocPage[]): [NeoDocPage, NeoDocPage][] {
  const byFile = new Map(pages.map((page) => [page.file, page]));
  const pairs: [NeoDocPage, NeoDocPage][] = [];
  for (const page of pages) {
    if (page.locale !== 'en') continue;
    const arabic = byFile.get(arabicFileOf(page.file)!);
    if (arabic) pairs.push([page, arabic]);
  }
  return pairs;
}

/** A problem found while checking the guide. */
export interface NeoDocProblem {
  /** Short machine-readable code, e.g. `missing-file`. */
  code: string;
  /** The file the problem is in, when one is. */
  file?: string;
  /** Human-readable description. */
  message: string;
}

/**
 * Validate a built guide: every file present, every local link resolving to a
 * page that exists, every fragment resolving to a heading on its page, and the
 * English and Arabic editions carrying the same section structure.
 *
 * Returns `[]` for a clean guide. The codes are stable so the CLI can count
 * them and a test can assert on a specific failure.
 */
export function checkNeoDocs(manifest: NeoDocsManifest): NeoDocProblem[] {
  const problems: NeoDocProblem[] = [];
  const byFile = new Map(manifest.pages.map((page) => [page.file, page]));

  for (const file of manifest.missing) {
    problems.push({
      code: 'missing-file',
      file,
      message: `docs/neo/${file} is listed in NEO_DOC_FILES but was not found`,
    });
  }

  for (const page of manifest.pages) {
    for (const target of docLinks(page.body)) {
      if (isExternalLink(target)) continue;
      const path = linkPath(target);
      if (!path) {
        // A bare fragment (`#section`) is a link inside the same page. Its
        // anchor is checked below against this page, not looked up as a file.
        const hash = target.indexOf('#');
        const fragment = hash === -1 ? '' : target.slice(hash + 1);
        if (fragment && !page.anchors.includes(headingAnchor(fragment))) {
          problems.push({
            code: 'broken-anchor',
            file: page.file,
            message: `${page.file} links to ${target}, but that page has no such heading`,
          });
        }
        continue;
      }
      const resolved = byFile.get(path);
      if (!resolved) {
        problems.push({
          code: 'broken-link',
          file: page.file,
          message: `${page.file} links to ${path}, which is not a page in the guide`,
        });
        continue;
      }
      const hash = target.indexOf('#');
      if (hash === -1) continue;
      const fragment = target.slice(hash + 1);
      if (!resolved.anchors.includes(headingAnchor(fragment))) {
        problems.push({
          code: 'broken-anchor',
          file: page.file,
          message: `${page.file} links to ${target}, but ${path} has no such heading`,
        });
      }
    }

    for (const related of page.related) {
      if (isFragmentOnly(related)) continue;
      if (!byFile.has(related)) {
        problems.push({
          code: 'broken-related',
          file: page.file,
          message: `${page.file} lists ${related} as related, but it is not a page`,
        });
      }
    }

    // A page with no `Related:` line is a guide that forgot to point onward.
    if (page.related.length === 0 && page.file !== 'README.md' && page.file !== 'README.ar.md') {
      problems.push({
        code: 'missing-related',
        file: page.file,
        message: `${page.file} has no "Related:" cross-reference line`,
      });
    }
  }

  for (const [english, arabic] of localePairs(manifest.pages)) {
    const sameCount = english.sections.length === arabic.sections.length;
    if (!sameCount) {
      problems.push({
        code: 'locale-drift',
        file: arabic.file,
        message: `${arabic.file} has ${arabic.sections.length} headings, ${english.file} has ${english.sections.length}`,
      });
    }
    // Both editions must point at the same *subjects*. The Arabic page links
    // with Arabic labels and the index with Arabic file names, so the raw
    // targets can differ by design (`missions.ar.md` vs `missions.md`); what
    // must agree is the number of subjects each edition references.
    if (english.related.length !== arabic.related.length) {
      problems.push({
        code: 'locale-drift',
        file: arabic.file,
        message: `${arabic.file} points at ${arabic.related.length} pages, ${english.file} points at ${english.related.length}`,
      });
    }
  }

  return problems;
}

/** Escape the five characters that are special in HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render one inline Markdown span: `code`, `**bold**`, `*italic*`, `[text](href)`. */
export function renderInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    '<a href="$2">$1</a>',
  );
  return out;
}

/**
 * Render a Markdown body to a self-contained HTML fragment.
 *
 * Covers the subset the guide uses: ATX headings with `id` anchors, fenced
 * code blocks, blockquotes, unordered and ordered lists (one level), tables,
 * thematic breaks and paragraphs. Anything else becomes a paragraph, so a
 * future block type degrades to visible text instead of vanishing.
 */
export function docsHtml(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let i = 0;

  const closeList = (kind: 'ul' | 'ol' | null) => {
    if (kind) out.push(kind === 'ul' ? '</ul>' : '</ol>');
  };

  let listKind: 'ul' | 'ol' | null = null;
  let inTable = false;
  let inFence = false;
  let fenceLang = '';
  const fenceLines: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    closeList(listKind);
    listKind = null;
    if (inTable) {
      out.push('</table>');
      inTable = false;
    }
    if (paragraph.length > 0) {
      out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (/^```/.test(line)) {
      if (inFence) {
        out.push(
          `<pre><code${fenceLang ? ` class="language-${fenceLang}"` : ''}>${escapeHtml(fenceLines.join('\n'))}</code></pre>`,
        );
        fenceLines.length = 0;
        inFence = false;
        fenceLang = '';
      } else {
        flushParagraph();
        inFence = true;
        fenceLang = line.slice(3).trim();
      }
      i++;
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1]!.length;
      const text = heading[2]!;
      out.push(`<h${level} id="${headingAnchor(text)}">${renderInline(text)}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushParagraph();
      out.push('<hr>');
      i++;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (listKind !== 'ul') {
        flushParagraph();
        out.push('<ul>');
        listKind = 'ul';
      }
      out.push(`<li>${renderInline(bullet[1]!)}</li>`);
      i++;
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      if (listKind !== 'ol') {
        flushParagraph();
        out.push('<ol>');
        listKind = 'ol';
      }
      out.push(`<li>${renderInline(ordered[1]!)}</li>`);
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderInline(quote.join(' '))}</blockquote>`);
      continue;
    }

    if (line.includes('|') && /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      flushParagraph();
      const cells = (row: string) =>
        row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      out.push('<table>');
      out.push('<thead><tr>');
      for (const cell of cells(line)) out.push(`<th>${renderInline(cell)}</th>`);
      out.push('</tr></thead>');
      i += 2; // header row + separator row
      out.push('<tbody>');
      while (i < lines.length && lines[i]!.includes('|') && /^\s*\|?/.test(lines[i]!)) {
        out.push('<tr>');
        for (const cell of cells(lines[i]!)) out.push(`<td>${renderInline(cell)}</td>`);
        out.push('</tr>');
        i++;
      }
      out.push('</tbody></table>');
      continue;
    }

    if (inTable) {
      out.push('</table>');
      inTable = false;
    }

    paragraph.push(line.trim());
    i++;
  }

  if (inFence) {
    out.push(`<pre><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`);
  }
  flushParagraph();
  return out.join('\n');
}

/** The HTML shell the in-app help route renders the guide inside. */
export function docsPageHtml(page: NeoDocPage, docsTitle: string): string {
  return [
    '<!doctype html>',
    `<html lang="${page.locale}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(page.title)} - ${escapeHtml(docsTitle)}</title>`,
    '</head>',
    '<body>',
    docsHtml(page.body),
    '</body>',
    '</html>',
  ].join('\n');
}
