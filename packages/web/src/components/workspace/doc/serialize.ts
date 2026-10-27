/** Serialize the contenteditable document DOM into the XML-like html fragment the
 *  workspace doc server expects (well-formed, only data-/src/alt/style attributes kept). */

const VOID_TAGS = new Set(['br', 'img', 'hr']);
const UNWRAP_TAGS = new Set(['thead', 'tbody', 'colgroup']);
const PARAGRAPH_TAGS = new Set(['p', 'div', 'blockquote', 'pre', 'span', 'a']);
const LIST_TAGS = new Set(['ul', 'ol', 'menu']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const KEEP_STYLES = new Set(['font-family', 'font-size', 'color', 'background-color', 'text-align', 'font-weight', 'font-style', 'text-decoration']);

/** execCommand("fontSize", n) emits <font size="n"> with a coarse 1-7 scale; the editor
 *  normalizes those into whitelisted <span style="font-size: Npx"> immediately. */
export const FONT_SIZE_STEPS: Record<string, number> = { '1': 8, '2': 10, '3': 12, '4': 14, '5': 18, '6': 24, '7': 32 };

/** Normalize a CSS color to #rrggbb so the doc round trip (which only maps six-digit hex)
 *  survives the rgb()/rgba() and #rgb spellings engines put into inline styles.
 *  Returns null for anything ambiguous (named colors, translucent alpha, gradients). */
export function normalizeCssColor(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    const [r, g, b] = [trimmed[1]!, trimmed[2]!, trimmed[3]!].map((c) => c + c);
    return `#${r}${g}${b}`;
  }
  const rgb = /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*(?:,\s*([0-9.]+)\s*)?\)$/.exec(trimmed);
  if (!rgb) return null;
  const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
  if (alpha < 1) return null;
  const channels = [rgb[1]!, rgb[2]!, rgb[3]!].map((c) => {
    const n = Number(c);
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n.toString(16).padStart(2, '0') : null;
  });
  if (channels.some((c) => c === null)) return null;
  return `#${channels.join('')}`;
}

/** Replace every transient <font size="n"> under `root` with a whitelisted
 *  <span style="font-size: Npx"> (fixed 1-7 map). `overrideSevenPx` redirects the
 *  just-applied size 7 to an arbitrary pixel size, letting the toolbar offer sizes
 *  beyond the command's 1-7 range; other sizes still use the fixed map. */
export function normalizeFontSizes(root: HTMLElement, overrideSevenPx?: number): void {
  for (const font of Array.from(root.querySelectorAll('font[size]'))) {
    const size = String(font.getAttribute('size') ?? '');
    const px = overrideSevenPx !== undefined && size === '7' ? overrideSevenPx : FONT_SIZE_STEPS[size];
    const span = document.createElement('span');
    if (px !== undefined) span.setAttribute('style', `font-size: ${px}px`);
    while (font.firstChild) span.appendChild(font.firstChild);
    font.replaceWith(span);
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function filteredStyle(node: Element): string {
  const style = node.getAttribute('style') ?? '';
  const kept: string[] = [];
  for (const part of style.split(';')) {
    const index = part.indexOf(':');
    if (index < 1) continue;
    const name = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    if (!value) continue;
    if (name === 'background-color') {
      // Only an exact #rrggbb highlight survives the server's inline recognition.
      const hex = normalizeCssColor(value);
      if (hex) kept.push(`background-color:${hex}`);
    } else if (name === 'color') {
      // Prefer normalized hex (the server maps hex only); other spellings keep their
      // legacy verbatim pass-through for display fidelity.
      const hex = normalizeCssColor(value);
      kept.push(`color:${hex ?? value}`);
    } else if (KEEP_STYLES.has(name)) {
      kept.push(`${name}:${value}`);
    }
  }
  return kept.join(';');
}

function attributes(node: Element): string {
  const out: string[] = [];
  for (const name of Array.from(node.attributes, (a) => a.name)) {
    const value = node.getAttribute(name) ?? '';
    if (name.startsWith('data-')) out.push(`${name}="${escapeXml(value)}"`);
    else if (node.tagName.toLowerCase() === 'img' && (name === 'src' || name === 'alt')) out.push(`${name}="${escapeXml(value)}"`);
  }
  const style = filteredStyle(node);
  if (style) out.push(`style="${escapeXml(style)}"`);
  return out.length ? ` ${out.join(' ')}` : '';
}

function isInlineElement(tag: string): boolean {
  return PARAGRAPH_TAGS.has(tag) || tag === 'strong' || tag === 'b' || tag === 'em' || tag === 'i' || tag === 'u' || tag === 's' || tag === 'font';
}

function emit(node: Element | Node): string {
  if (node.nodeType === 3) {
    return escapeXml((node.nodeValue ?? '').replace(/\u00a0/g, ' '));
  }
  if (node.nodeType !== 1) return '';
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'link') return '';
  if (VOID_TAGS.has(tag)) {
    if (tag === 'img') return `<img${attributes(element)}/>`;
    return '<br/>';
  }
  if (UNWRAP_TAGS.has(tag)) {
    return Array.from(element.childNodes, emit).join('');
  }
  if (!isInlineElement(tag) && !LIST_TAGS.has(tag) && !HEADINGS.has(tag) && tag !== 'p' && tag !== 'table' && tag !== 'tr' && tag !== 'td' && tag !== 'th') {
    return Array.from(element.childNodes, emit).join('');
  }
  const children = Array.from(element.childNodes, emit).join('');
  return `<${tag}${attributes(element)}>${children}</${tag}>`;
}

export function serializeEditor(root: HTMLElement): string {
  normalizeFontSizes(root);
  const body = Array.from(root.childNodes, emit).join('');
  return body.trim() || '<p></p>';
}

/** Split the server html payload into its marker header and the renderable fragment. */
export function splitMarker(html: string): { marker: string; fragment: string } {
  const match = /^(<!--\s*doc-session\s[^>]*-->)\s*([\s\S]*)$/.exec(html);
  return { marker: match?.[1] ?? '', fragment: match?.[2] ?? html };
}
