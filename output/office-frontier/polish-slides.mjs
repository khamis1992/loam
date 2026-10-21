import fs from 'node:fs';
let p='ui/studio-slides.js',s=fs.readFileSync(p,'utf8');s=s.replace("box(parts[i]||'عنوان\\nوصف البطاقة',6+i*30,32,28,54,22,ink,false,'#E2EEE8')","({...box(parts[i]||'عنوان\\nوصف البطاقة',6+i*30,35,28,38,26,ink,true,'#E2EEE8'),alignment:'center'})");fs.writeFileSync(p,s);
p='ui/studio.js';s=fs.readFileSync(p,'utf8');s=s.replace("const boxStyle=box=>styleText(box)+", "const boxStyle=box=>styleText(box)+(box.background?';padding:1.25cqw!important':'')+");fs.writeFileSync(p,s);
p='src/studio/export.ts';s=fs.readFileSync(p,'utf8').replace("valign:'top',margin:0,breakLine:false,fit:'shrink'","valign:'top',margin:box.background?12:0,breakLine:false,fit:'shrink'");fs.writeFileSync(p,s);
