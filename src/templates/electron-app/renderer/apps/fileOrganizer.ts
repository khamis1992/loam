import { element, errorStatus, page, status } from '../dom.js';
import type { DesktopApi, LocalFile } from '../types.js';

export function initFileOrganizer(desktop: DesktopApi): void {
  page('Loam File Organizer', 'Search, filter and tag files in your local workspace.', `
    <section class="toolbar" aria-label="File filters">
      <label>Search files<input id="search" type="search" placeholder="Try notes or budget" autocomplete="off"></label>
      <label>Filter by tag<input id="tag-filter" type="text" placeholder="important" autocomplete="off"></label>
      <button id="refresh" type="button">Refresh</button>
    </section>
    <section class="workspace"><div class="list-heading"><h2>Downloads</h2><span id="count" aria-live="polite"></span></div><div id="files" aria-live="polite"></div></section>
    <section class="tag-panel" aria-label="Add a tag"><h2>Add a tag</h2><form id="tag-form">
      <label>File<select id="file-select" required></select></label>
      <label>Tag<input id="tag-input" maxlength="24" placeholder="important" required autocomplete="off"></label>
      <button type="submit">Add tag</button><p id="status" role="status"></p>
    </form></section>`);

  const search = element<HTMLInputElement>('#search');
  const tagFilter = element<HTMLInputElement>('#tag-filter');
  const filesElement = element<HTMLDivElement>('#files');
  const fileSelect = element<HTMLSelectElement>('#file-select');

  function row(file: LocalFile): HTMLElement {
    const row = document.createElement('article');
    row.className = 'file-row';
    row.dataset.name = file.name;
    const title = document.createElement('strong');
    title.textContent = file.name;
    const details = document.createElement('span');
    details.textContent = `${file.size} bytes`;
    const tags = document.createElement('div');
    tags.className = 'tags';
    for (const tag of file.tags) {
      const badge = document.createElement('span');
      badge.textContent = tag;
      tags.appendChild(badge);
    }
    row.append(title, details, tags);
    return row;
  }

  async function refresh(): Promise<void> {
    try {
      const files = await desktop.listFiles({ query: search.value, tag: tagFilter.value });
      filesElement.replaceChildren(...files.map(row));
      element<HTMLSpanElement>('#count').textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
      const selected = fileSelect.value;
      fileSelect.replaceChildren(...files.map((file) => {
        const option = document.createElement('option');
        option.value = file.name;
        option.textContent = file.name;
        return option;
      }));
      if (files.some((file) => file.name === selected)) fileSelect.value = selected;
    } catch (error) { errorStatus(error); }
  }

  element<HTMLButtonElement>('#refresh').addEventListener('click', () => { void refresh(); });
  search.addEventListener('input', () => { void refresh(); });
  tagFilter.addEventListener('input', () => { void refresh(); });
  element<HTMLFormElement>('#tag-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = element<HTMLInputElement>('#tag-input');
    try {
      await desktop.addTag(fileSelect.value, input.value);
      status('Tag added.');
      input.value = '';
      await refresh();
    } catch (error) { errorStatus(error); }
  });
  void refresh();
}
