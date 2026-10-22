export async function showWordPreview(root,taskId,options={}){
 const host=root.querySelector('[data-file-preview]');if(!host)return;
 const frame=document.createElement('iframe');frame.title='معاينة صفحات ملف Word';frame.setAttribute('sandbox','allow-scripts');frame.className='office-file-preview';
 let dispose;
 const loaded=new Promise(resolve=>{const listener=e=>{if(e.source===frame.contentWindow&&e.data?.type==='loam-docx-load'){window.removeEventListener('message',listener);resolve();}};window.addEventListener('message',listener);dispose=()=>window.removeEventListener('message',listener);});
 frame.src='/office-preview.html';host.replaceChildren(frame);
 const editorListener=async event=>{
  if(event.source!==frame.contentWindow||!frame.isConnected)return;
  if(event.data?.type==='loam-preview-editing')options.onEditing?.(!!event.data.editing);
  if(event.data?.type==='loam-preview-commit'){
   try{await options.onCommit?.(event.data.operation,event.data.revision,event.data.scrollY);}
   catch(error){frame.contentWindow?.postMessage({type:'loam-preview-error',message:error.message},'*');}
  }
 };
 window.addEventListener('message',editorListener);
 const observer=new MutationObserver(()=>{if(!frame.isConnected){window.removeEventListener('message',editorListener);observer.disconnect();}});observer.observe(document.body,{childList:true,subtree:true});
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),150000);
 try{
  const response=await fetch('/api/studio/preview?taskId='+encodeURIComponent(taskId)+(options.artifact?'&interactive=1':''),{signal:controller.signal});
  if(!response.ok){const result=await response.json().catch(()=>({}));throw Error(result.error||'تعذّر تجهيز معاينة Word');}
  const bytes=await response.arrayBuffer();
  await Promise.race([loaded,new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('انتهت مهلة تحميل المعاينة')),{once:true}))]);
  if(options.artifact&&Number(response.headers.get('x-loam-revision'))!==options.artifact.revision)throw Error('تغيّر المستند أثناء تجهيز المعاينة. حدّث المعاينة قبل التعديل.');
  if(frame.isConnected)frame.contentWindow.postMessage({type:'loam-pdf-preview',bytes,artifact:options.artifact,scrollY:options.scrollY},'*',[bytes]);
 }catch(error){if(frame.isConnected)host.textContent=error.name==='AbortError'?'استغرق Word وقتًا أطول من المتوقع. أعد محاولة المعاينة.':error.message;}
 finally{clearTimeout(timer);dispose();}
}
