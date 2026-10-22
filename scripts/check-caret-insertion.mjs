import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {previewEdit} from '../ui/studio-preview-edit.js';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1000,height:800}});
 await page.route('http://caret.test/**',async route=>{const name=new URL(route.request().url()).pathname;await route.fulfill({contentType:'text/javascript',body:await fs.readFile('ui'+name,'utf8')});});
 await page.setContent('<style>.word-caret-editor{white-space:pre-wrap}</style><section style="position:relative;width:600px;height:700px"></section>');
 await page.evaluate(async()=>{
  window.commits=[];addEventListener('message',e=>{if(e.data.type==='loam-preview-commit')window.commits.push(e.data);});
  const {setupEditor,addEditTargets}=await import('http://caret.test/office-preview-editor.js');
  setupEditor({kind:'document',revision:1,content:{blocks:[{type:'paragraph',text:'Original paragraph',sourceNode:3}]}});
  await addEditTargets({getAnnotations:async()=>[{url:'https://loam.invalid/edit/0/text',rect:[30,100,450,125]}],getTextContent:async()=>({items:[]})},document.querySelector('section'),{width:600,height:700,scale:1,convertToViewportRectangle:r=>r});
 });
 await page.locator('[data-target]').click();const caret=page.getByRole('textbox',{name:'الكتابة داخل السطر'});
 await caret.fill('Updated first line');await caret.press('End');await caret.press('Enter');await page.keyboard.insertText('السطر الثاني');
 await page.locator('[data-caret-insert]').click();await page.locator('[data-inline-text]').fill('Cancelled insertion');await page.locator('[data-cancel]').last().click();
 assert.equal(await caret.innerText(),'Updated first line\nالسطر الثاني');assert.equal(await page.evaluate(()=>window.commits.length),0);
 await page.locator('[data-caret-insert]').click();await page.locator('[data-inline-text]').fill('Inserted block');await page.locator('[data-commit]').click();
 await page.waitForFunction(()=>window.commits.length===1);const {operation,revision}=await page.evaluate(()=>window.commits[0]);
 assert.equal(operation.sourceText,'Updated first line\nالسطر الثاني');assert.equal(operation.offset,operation.sourceText.length);
 const original={kind:'document',revision:1,content:{blocks:[{type:'paragraph',text:'Original paragraph',sourceNode:3}]}};
 const result=previewEdit(original,operation,revision);assert.equal(result.content.blocks[0].text,operation.sourceText);assert.equal(result.content.blocks[1].text,'Inserted block');assert.equal(result.content.blocks[2].text,'');assert.equal(result.content.blocks[2].continuationOf,3);assert.equal(original.content.blocks[0].text,'Original paragraph');
 assert.throws(()=>previewEdit(original,{...operation,sourceText:3},revision));assert.throws(()=>previewEdit(original,{...operation,offset:9999},revision));
 console.log('PASS draft-preserving cancel, multiline Arabic caret offset, atomic text and insertion, original identity and validation');
}finally{await browser.close();}
