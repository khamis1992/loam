/** Serialize the contenteditable document DOM into the XML-like html fragment the
 *  workspace doc server expects (well-formed, only data-/src/alt/style attributes kept). */

const VOID_TAGS = new Set(['br', 'img', 'hr']);
const UNWRAP_TAGS = new Set(['thead', 'tbody', 'colgroup']);
const PARAGRAPH_TAGS = new Set(['p', 'div', 'blockquote', 'pre', 'span', 'a']);
const LIST_TAGS = new Set(['ul', 'ol', 'menu']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const KEEP_STYLES = new Set(['font-family', 'font-size', 'color', 'text-align', 'font-weight', 'font-style', 'text-decoration']);

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
    if (KEEP_STYLES.has(name) && value) kept.push(`${name}:${value}`);
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
  const body = Array.from(root.childNodes, emit).join('');
  return body.trim() || '<p></p>';
}

/** Split the server html payload into its marker header and the renderable fragment. */
export function splitMarker(html: string): { marker: string; fragment: string } {
  const match = /^(<!--\s*doc-session\s[^>]*-->)\s*([\s\S]*)$/.exec(html);
  return { marker: match?.[1] ?? '', fragment: match?.[2] ?? html };
}
