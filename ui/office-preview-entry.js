import {getDocument} from 'pdfjs-dist/build/pdf.mjs';
import {WorkerMessageHandler} from 'pdfjs-dist/build/pdf.worker.mjs';
import {setupEditor,addEditTargets,addInsertionMenu,editorError} from './office-preview-editor.js';
globalThis.pdfjsWorker={WorkerMessageHandler};
const pages=document.querySelector('#pages'),status=document.querySelector('#status'),toolbar=document.querySelector('#toolbar'),counter=document.querySelector('#counter');
let rendering=false;
window.addEventListener('message',async event=>{
 if(event.source===parent&&event.data?.type==='loam-preview-error'){editorError(event.data.message);return;}
 if(event.source!==parent||event.data?.type!=='loam-pdf-preview'||rendering)return;
 rendering=true;
 try{
  setupEditor(event.data.artifact);
  const pdf=await getDocument({data:new Uint8Array(event.data.bytes),isEvalSupported:false,useSystemFonts:true}).promise;
  counter.textContent=`${pdf.numPages} صفحات · Microsoft Word`;toolbar.hidden=false;
  for(let number=1;number<=pdf.numPages;number++){
   const page=await pdf.getPage(number),viewport=page.getViewport({scale:1.5});
   const section=document.createElement('section');section.className='word-page';section.dataset.page=number;section.setAttribute('aria-label',`صفحة ${number} من ${pdf.numPages}`);
   const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);canvas.style.width='100%';canvas.style.height='auto';
   section.style.width=viewport.width/1.5+'px';section.append(canvas);pages.append(section);
   await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
   const text=await page.getTextContent();section.setAttribute('aria-description',text.items.map(item=>item.str||'').join(' '));
   await addEditTargets(page,section,viewport);
   status.textContent=`جارٍ عرض الصفحة ${number} من ${pdf.numPages}…`;page.cleanup();
  }
  status.hidden=true;
  addInsertionMenu(toolbar);
  if(Number.isFinite(event.data.scrollY))window.scrollTo(0,event.data.scrollY);
  document.querySelector('#zoom').addEventListener('change',event=>{pages.classList.toggle('actual-size',event.target.value==='100');});
  parent.postMessage({type:'loam-docx-ready',pages:pdf.numPages,engine:'microsoft-word'},'*');
 }catch(error){status.textContent='تعذّر عرض المعاينة. أعد المحاولة أو نزّل الملف لفتحه في Word.';console.error(error);}finally{rendering=false;}
});
parent.postMessage({type:'loam-docx-load'},'*');
