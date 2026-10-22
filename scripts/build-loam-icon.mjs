import fs from 'node:fs';
import sharp from 'sharp';
const png = await sharp('ui/assets/loam-symbol.svg').resize(256,256).png().toBuffer();
fs.mkdirSync('electron/assets',{recursive:true});
fs.writeFileSync('electron/assets/loam.png',png);
// Native small-size entries keep taskbar, shortcut and installer icons crisp.
const sizes=[16,24,32,48,64,128,256];
const images=await Promise.all(sizes.map(size=>sharp('ui/assets/loam-symbol.svg').resize(size,size).png().toBuffer()));
const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
let offset=header.length;
images.forEach((image,i)=>{const entry=6+i*16;header[entry]=sizes[i]===256?0:sizes[i];header[entry+1]=header[entry];header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);header.writeUInt32LE(image.length,entry+8);header.writeUInt32LE(offset,entry+12);offset+=image.length;});
fs.writeFileSync('electron/assets/loam.ico',Buffer.concat([header,...images]));
console.log('Loam Windows icon generated.');
