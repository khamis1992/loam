import { element, errorStatus, page, status } from '../dom.js';
import type { DesktopApi, PhotoRecord } from '../types.js';

export function initPhotoSorter(desktop: DesktopApi): void {
  page('Loam Photo Sorter', 'Find exact duplicates by file hash and copy photos into a sorted folder.', `
    <section class="workspace"><div class="list-heading"><h2>Local photos</h2><div class="actions"><button id="scan-photos" type="button">Scan photos</button><button id="sort-photos" class="secondary" type="button" disabled>Sort photos</button></div></div>
      <div id="photos"></div><p id="status" class="status" role="status"></p>
    </section>`);

  function row(photo: PhotoRecord): HTMLElement {
    const row = document.createElement('article');
    row.className = 'photo-row';
    const name = document.createElement('strong');
    name.textContent = photo.name;
    const details = document.createElement('span');
    details.textContent = `${photo.size} bytes · ${photo.sha256.slice(0, 12)}`;
    const badge = document.createElement('span');
    badge.className = photo.duplicateOf ? 'badge duplicate' : 'badge';
    badge.textContent = photo.duplicateOf ? `Duplicate of ${photo.duplicateOf}` : 'Unique';
    row.append(name, details, badge);
    return row;
  }

  element<HTMLButtonElement>('#scan-photos').addEventListener('click', async () => {
    try {
      const photos = await desktop.scanPhotos();
      element<HTMLDivElement>('#photos').replaceChildren(...photos.map(row));
      const duplicates = photos.filter((photo) => photo.duplicateOf).length;
      status(`${photos.length} photos scanned · ${duplicates} duplicate found.`);
      element<HTMLButtonElement>('#sort-photos').disabled = photos.length === 0;
    } catch (error) { errorStatus(error); }
  });

  element<HTMLButtonElement>('#sort-photos').addEventListener('click', async () => {
    try {
      const result = await desktop.sortPhotos();
      status(`Sorted ${result.sortedCount} photos into the local sorted folder.`);
    } catch (error) { errorStatus(error); }
  });

  void desktop.scanPhotos().then((photos) => {
    element<HTMLDivElement>('#photos').replaceChildren(...photos.map(row));
    element<HTMLButtonElement>('#sort-photos').disabled = photos.length === 0;
  }).catch(errorStatus);
}
