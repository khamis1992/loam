import { element, errorStatus, page, status } from '../dom.js';
import type { DesktopApi } from '../types.js';

function escaped(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(value: string): string {
  return escaped(value).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
}

export function renderMarkdown(source: string): string {
  return source.split(/\r?\n/).map((line) => {
    if (line.startsWith('### ')) return `<h3>${inline(line.slice(4))}</h3>`;
    if (line.startsWith('## ')) return `<h2>${inline(line.slice(3))}</h2>`;
    if (line.startsWith('# ')) return `<h1>${inline(line.slice(2))}</h1>`;
    if (line.startsWith('- ')) return `<p>• ${inline(line.slice(2))}</p>`;
    return line.trim() ? `<p>${inline(line)}</p>` : '';
  }).join('');
}

export function initMarkdownEditor(desktop: DesktopApi): void {
  page('Loam Markdown Editor', 'Write, preview and save Markdown locally without a connection.', `
    <section class="toolbar"><label>Document<select id="document-select"></select></label><span></span><button id="save-document" type="button">Save document</button></section>
    <section class="editor-panel"><div class="editor-layout">
      <label>Markdown<textarea id="markdown-input" spellcheck="true"></textarea></label>
      <div><p class="muted">Live preview</p><div id="preview"></div></div>
    </div><p id="status" class="status" role="status"></p></section>`);

  const select = element<HTMLSelectElement>('#document-select');
  const input = element<HTMLTextAreaElement>('#markdown-input');
  const preview = element<HTMLDivElement>('#preview');
  const update = () => { preview.innerHTML = renderMarkdown(input.value); };
  input.addEventListener('input', update);

  async function load(name: string): Promise<void> {
    try {
      const document = await desktop.readDocument(name);
      select.value = name;
      input.value = document.content;
      update();
    } catch (error) { errorStatus(error); }
  }

  select.addEventListener('change', () => { void load(select.value); });
  element<HTMLButtonElement>('#save-document').addEventListener('click', async () => {
    try {
      await desktop.writeDocument(select.value || 'welcome.md', input.value);
      status('Document saved locally.');
    } catch (error) { errorStatus(error); }
  });

  void desktop.listDocuments().then(async (documents) => {
    if (!documents.includes('welcome.md')) documents.unshift('welcome.md');
    select.replaceChildren(...documents.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      return option;
    }));
    await load(select.value || 'welcome.md');
  }).catch(errorStatus);
}
