import assert from 'node:assert/strict';
import sharp from 'sharp';
import JSZip from 'jszip';
import {validateStudio, type StudioArtifact} from '../studio/store.js';
import {exportStudio} from '../studio/export.js';

const png=await sharp({create:{width:800,height:400,channels:3,background:'#087f8c'}}).png().toBuffer();
const artifact:StudioArtifact={kind:'document',title:'تقرير تجريبي',revision:1,content:{blocks:[
 {type:'stats',text:'قيم توضيحية فقط',items:[{value:'92%',label:'الاكتمال',tone:'teal'},{value:'24',label:'مهمة',tone:'blue'},{value:'3',label:'مراحل',tone:'amber'}]},
 {type:'table',text:'خطة العمل',columns:['المرحلة','المخرج','الحالة'],rows:Array.from({length:60},(_,i)=>['مرحلة '+i,'محتوى عربي قابل للتحرير','قيد المراجعة'])},
 {type:'image',text:'صورة توضيحية',alt:'مستطيل أخضر',src:'data:image/png;base64,'+png.toString('base64')},
]}};
const clean=validateStudio(artifact) as StudioArtifact;
assert.deepEqual(clean.content,artifact.content);
const output=await exportStudio(artifact),zip=await JSZip.loadAsync(output.buffer),xml=await zip.file('word/document.xml')!.async('string');
assert.equal((xml.match(/<w:tbl>/g)||[]).length,2);
assert.match(xml,/w:tblHeader/);assert.match(xml,/w:cantSplit/);assert.match(xml,/w:bidiVisual/);
assert.match(xml,/w:fill="182F3A"/);assert.match(xml,/w:fill="FFF4DE"/);assert.match(xml,/محتوى عربي قابل للتحرير/);
assert.match(xml,/wp:extent cx="5905500" cy="2952750"/);assert.match(xml,/descr="مستطيل أخضر"/);
assert.ok(Object.keys(zip.files).some(p=>p.startsWith('word/media/')&&p.endsWith('.png')));
const arabicCards=await exportStudio({kind:'document',title:'English filename',revision:1,content:{blocks:[{type:'stats',text:'',items:[{value:'24',label:'المهام',tone:'teal'}]}]}});
assert.match(await (await JSZip.loadAsync(arabicCards.buffer)).file('word/document.xml')!.async('string'),/w:bidiVisual/);
const invalid=(block:unknown)=>assert.throws(()=>validateStudio({...artifact,content:{blocks:[block]}}));
invalid({type:'stats',items:[]});invalid({type:'stats',items:[{value:'1',label:'x',tone:'red'}]});
invalid({type:'table',columns:['a','b'],rows:[['a']]});invalid({type:'table',columns:Array(7).fill('a'),rows:[]});
invalid({type:'image',src:'https://example.com/image.png'});invalid({type:'image',src:'data:image/png;base64,YWJj'});
assert.doesNotThrow(()=>validateStudio({...artifact,sourceId:'00000000-0000-0000-0000-000000000000'}));
invalid({...artifact.content.blocks[0],sourceIndex:0});
await assert.rejects(()=>exportStudio({...artifact,content:{blocks:[{type:'image',src:'data:image/png;base64,iVBORw0KGgo=',text:'',alt:''}]}}));
console.log('PASS: editable RTL cards/tables, repeated header, unsplit rows, embedded image dimensions/alt, limits and malformed image rejection.');
