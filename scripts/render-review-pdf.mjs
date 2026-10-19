import fs from 'node:fs/promises';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
const [file,prefix]=process.argv.slice(2);if(!file||!prefix)throw Error('Usage: render-review-pdf.mjs input.pdf output-prefix');
await fs.mkdir(path.dirname(prefix),{recursive:true});const pdf=await getDocument({data:new Uint8Array(await fs.readFile(file))}).promise;
for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i),viewport=page.getViewport({scale:1.5}),canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;await fs.writeFile(`${prefix}-${i}.png`,canvas.toBuffer('image/png'));}
console.log(`Rendered ${pdf.numPages} pages`);await pdf.destroy();
