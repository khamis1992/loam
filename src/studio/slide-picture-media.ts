import type JSZip from 'jszip';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { embeddedPicture } from './embedded-picture.js';
import { all, first, part, attr, serialize, P, A, R } from './ooxml.js';
import { StudioError } from './store.js';

type Picture = Record<string, string | number | boolean>;
export async function patchSlidePictureMedia(zip: JSZip, file: string, doc: any, current: Picture[] = [], original: Picture[] = []) {
  for (const picture of current) {
    const old = original.find(p => p.id === picture.id);
    if (picture.src === undefined || picture.src === old?.src) continue;
    const shape = all(doc, P, 'pic').find(p => attr(first(p, P, 'cNvPr'), 'id') === picture.id);
    const blip = shape && first(shape, A, 'blip');
    if (!old || !blip) throw new StudioError('Original picture is unavailable');
    let data: Buffer;
    try { data = await sharp(embeddedPicture(picture.src), { limitInputPixels: 24_000_000 }).rotate().png().toBuffer(); }
    catch { throw new StudioError('Use a valid PNG/JPEG replacement image'); }
    const name = 'loam-picture-' + randomUUID() + '.png', id = 'loam-' + randomUUID();
    // A new relationship prevents edits leaking to other uses of shared media.
    const relfile = path.posix.join(path.posix.dirname(file), '_rels', path.posix.basename(file) + '.rels');
    const rels = await part(zip, relfile), rel = rels.createElementNS('http://schemas.openxmlformats.org/package/2006/relationships', 'Relationship');
    rel.setAttribute('Id', id); rel.setAttribute('Type', R + '/image');
    rel.setAttribute('Target', path.posix.relative(path.posix.dirname(file), 'ppt/media/' + name));
    rels.documentElement.appendChild(rel); zip.file(relfile, serialize(rels));
    zip.file('ppt/media/' + name, data);
    const types = await part(zip, '[Content_Types].xml'), ct = types.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override');
    ct.setAttribute('PartName', '/ppt/media/' + name); ct.setAttribute('ContentType', 'image/png');
    types.documentElement.appendChild(ct); zip.file('[Content_Types].xml', serialize(types));
    blip.setAttributeNS(R, 'r:embed', id); blip.removeAttributeNS(R, 'link');
    // Remove the old SVG alternate so PowerPoint uses the replacement raster.
    for (const svg of all(blip, '*', 'svgBlip')) {
      const parent = svg.parentNode; parent.removeChild(svg);
      if (!parent.hasChildNodes()) parent.parentNode.removeChild(parent);
    }
  }
}
