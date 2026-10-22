const fs=require('fs');const p='ui/creative-timeline.js';let s=fs.readFileSync(p,'utf8');
function must(x){if(!s.includes(x)){console.error('MISSING:',JSON.stringify(x.slice(0,70)));process.exit(1);}}

must("if(b.dataset.fxAdd){");
const handlers=[
"if(b.dataset.fxLutLoad){const picker=document.createElement('input');picker.type='file';picker.accept='.cube';",
"picker.onchange=()=>{const file=picker.files[0];if(!file)return;void run(async()=>{",
"if(file.size>400000)throw Error('ملف LUT أكبر من 400KB.');",
"const cube=await file.text();parseCube(cube);",
"await edit(()=>{const effect=findEffect(project.clips.find(c2=>c2.id===selected),b.dataset.fxLutLoad);if(!effect)throw Error('المؤثر غير موجود.');effect.params.cube=cube;});",
"status('حُمّل جدول LUT ('+cube.length+' حرفًا).');});};picker.click();return;}",
"if(b.hasAttribute('data-clip-match-color')){void run(()=>edit(()=>{",
"const source=project.clips.find(c2=>c2.id===selected);if(!source)throw Error('اختر مقطعًا.');",
"const target=project.clips.find(c2=>c2.id!==source.id&&['image','video'].includes(c2.kind)&&c2.trackId!==source.trackId)||project.clips.find(c2=>c2.id!==source.id&&['image','video'].includes(c2.kind));",
"if(!target)throw Error('لا مقطع مرجعي آخر للمطابقة.');",
"const stats=clip=>{const el=engine.elements.get(clip.id)?.element;if(!el)throw Error('المقطع غير محمّل بعد؛ انتظر ثم أعد المحاولة.');",
"const probe=document.createElement('canvas');probe.width=48;probe.height=48;probe.getContext('2d').drawImage(el,0,0,48,48);",
"const data=probe.getContext('2d').getImageData(0,0,48,48).data;let r=0,g=0,b=0;",
"for(let i=0;i<data.length;i+=4){r+=data[i];g+=data[i+1];b+=data[i+2];}",
"const n=data.length/4;r/=n*255;g/=n*255;b/=n*255;",
"return {luma:.299*r+.587*g+.114*b,r,g,b,spread:Math.max(r,g,b)-Math.min(r,g,b)};};",
"const adjust=matchColorAdjust(stats(source),stats(target));",
"source.colorAdjust={enabled:true,brightness:adjust.brightness,contrast:1,saturation:adjust.saturation,hue:adjust.hue};",
"status('طُبقت مطابقة اللون على «'+source.name+'» نحو «'+target.name+'».');}));return;}",
].join('\n      ');
s=s.replace("if(b.dataset.fxAdd){",handlers+"\n      if(b.dataset.fxAdd){",1);

must("import {effectCatalog,addEffect,moveEffect,findEffect} from './creative-fx.js';");
s=s.replace("import {effectCatalog,addEffect,moveEffect,findEffect} from './creative-fx.js';","import {effectCatalog,addEffect,moveEffect,findEffect,parseCube,matchColorAdjust} from './creative-fx.js';",1);

must('<button data-tl-paste-props ');
s=s.replace('<button data-tl-paste-props ','<button data-clip-match-color title="مطابقة لون هذا المقطع مع مقطع مرجعي آخر">مطابقة اللون</button><button data-tl-paste-props ',1);
fs.writeFileSync(p,s);console.log('wire9 applied');
