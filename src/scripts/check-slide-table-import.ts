import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {importStudio} from '../studio/import.js';
import {exportStudio} from '../studio/export.js';
import {renderSlidePreview} from '../studio/slide-preview.js';
import {part,first,all,serialize,A} from '../studio/ooxml.js';
const out='output/office-frontier',workspace=await fs.mkdtemp(out+'/source-table-'),source=await fs.readFile(out+'/slides-with-table.pptx');
let artifact=await importStudio(workspace,source,'original-table.pptx',0);if(artifact.kind!=='presentation')throw Error();
assert.ok(artifact.content.slides[0]!.tableCells!.length>3);assert.deepEqual((await exportStudio(artifact,workspace)).buffer,source);
const bad=structuredClone(artifact);bad.content.slides[0]!.tableCells![0]!.x=90;await assert.rejects(()=>exportStudio(bad,workspace),/Only text/);
const missing=structuredClone(artifact);missing.content.slides[0]!.tableCells!.pop();await assert.rejects(()=>exportStudio(missing,workspace),/Preserve every/);
const server=createServer(async(req,res)=>{try{const u=new URL(req.url!,'http://localhost');if(u.pathname==='/api/studio/slide-preview'){res.setHeader('content-type','image/png');res.end(await renderSlidePreview((await exportStudio(artifact,workspace)).buffer,1));return;}if(u.pathname==='/api/studio'){if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);await exportStudio(body.artifact,workspace);artifact={...body.artifact,revision:artifact.revision+1};}res.setHeader('content-type','application/json');res.end(JSON.stringify({artifact}));return;}if(u.pathname==='/'){res.setHeader('content-type','text/html');res.end('<html dir="rtl"><link rel="stylesheet" href="/studio.css"><style>*{box-sizing:border-box}body{margin:20px;background:#10231b}</style><div id="host"></div><script type="module">import{createStudio}from"/studio.js";createStudio({ensureDraft:async()=>({id:"table"}),confirm:async()=>true}).mount(document.getElementById("host"),{mode:"write",taskId:"table",key:"table"});</script></html>');return;}res.setHeader('content-type',u.pathname.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile('ui'+u.pathname));}catch(e){res.statusCode=400;res.end(JSON.stringify({error:String(e)}));}});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true});
try{const page=await browser.newPage({viewport:{width:1450,height:1050}});await page.goto('http://127.0.0.1:'+(server.address() as any).port);await page.locator('.office-native-ready').waitFor({timeout:120000});await page.locator('[data-source-table-cell="0"]').fill('المؤشر المحدّث');await page.locator('[data-action=save]').click();await page.locator('[data-status]').filter({hasText:'الإصدار 2'}).waitFor();await page.locator('.office-native-status').filter({hasText:'تتجدد بعد الحفظ'}).waitFor({timeout:120000});await page.screenshot({path:out+'/original-table-editor.png'});
const output=await exportStudio(artifact,workspace);await fs.writeFile(out+'/original-table-edited.pptx',output.buffer);await fs.writeFile(out+'/original-table-native.png',await renderSlidePreview(output.buffer,1));
const before=await JSZip.loadAsync(source),after=await JSZip.loadAsync(output.buffer);let preserved=0;for(const name of Object.keys(before.files)){if(before.files[name]!.dir||['ppt/slides/slide1.xml','ppt/presentation.xml'].includes(name))continue;assert.deepEqual(await before.file(name)!.async('nodebuffer'),await after.file(name)!.async('nodebuffer'));preserved++;}
const b=first(await part(before,'ppt/slides/slide1.xml'),A,'tbl'),a=first(await part(after,'ppt/slides/slide1.xml'),A,'tbl');assert.equal(first(a,A,'t').textContent,'المؤشر المحدّث');for(const doc of [b,a])for(const t of all(doc,A,'t')){t.textContent='';t.removeAttribute('xml:space');}assert.equal(serialize(a),serialize(b),'Table structure and formatting must be unchanged');
console.log('PASS original table direct UI text edit, native preview refresh, preserved table properties and '+preserved+' supporting parts');
}finally{await browser.close();server.closeAllConnections();server.close();}
