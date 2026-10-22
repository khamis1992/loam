import { A, P, first, attr } from './ooxml.js';
import { StudioError } from './store.js';
export const cropKeys = ['cropLeft', 'cropTop', 'cropRight', 'cropBottom'] as const;
const edges = ['l', 't', 'r', 'b'];
type Picture = Record<string, string | number | boolean>;
export function importPictureCrop(shape: any): Record<string, number> {
  const rect = first(shape, A, 'srcRect');
  return Object.fromEntries(cropKeys.map((key, i) => {
    const raw = attr(rect, edges[i]!, '0');
    return [key, raw.endsWith('%') ? Number(raw.slice(0, -1)) : Number(raw) / 1000];
  }));
}
export function patchPictureCrop(shape: any, picture: Picture, original: Picture) {
  if (!cropKeys.some(k => picture[k] !== undefined && picture[k] !== original[k])) return;
  const current = importPictureCrop(shape), values = cropKeys.map(k => picture[k] ?? current[k]);
  if (values.some(v => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 10000) || Number(values[0]) + Number(values[2]) >= 100 || Number(values[1]) + Number(values[3]) >= 100) throw new StudioError('Keep a visible area when cropping the picture');
  const fill = first(shape, P, 'blipFill');
  if (!fill) throw new StudioError('Picture fill is unavailable');
  let rect = first(fill, A, 'srcRect');
  if (!rect) {
    rect = shape.ownerDocument.createElementNS(A, 'a:srcRect');
    fill.insertBefore(rect, first(fill, A, 'stretch') || first(fill, A, 'tile') || null);
  }
  cropKeys.forEach((key, i) => { if (picture[key] !== undefined) rect.setAttribute(edges[i]!, String(Math.round(Number(picture[key]) * 1000))); });
}

