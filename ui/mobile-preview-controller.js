import {bridgeMobileCode} from './mobile-code-bridge.js';

// One frame, one source snapshot and one storage bridge for edit, run and publish.
export function createUnifiedPreview({frame,onScreen,onSelect,onError,onExit}){
 let current,loaded='',dispose,dirtyTag='';
 const send=()=>frame.contentWindow?.postMessage({channel:'loam-mobile-host',type:'render',context:current},'*');
 function update(context,force=false){
  current=context;
  if(!context.taskId){
   frame.contentWindow?.postMessage({type:'mobile-render',...context},location.origin);
   return;
  }
  const tag=context.taskId+':'+context.project.revision;
  if(force||tag!==loaded){
   loaded=tag;dirtyTag='';dispose?.();
   frame.setAttribute('sandbox','allow-scripts');
   dispose=bridgeMobileCode(frame,{taskId:context.taskId,project:context.project,getContext:()=>current,onError,onScreen,onSelect,onExit});
   frame.src='/api/mobile/source-preview?taskId='+encodeURIComponent(context.taskId)+'&revision='+context.project.revision;
  }else{
   const next=JSON.stringify([context.project,context.screen,context.blockId,context.edit]);
   if(next!==dirtyTag){dirtyTag=next;send();}
  }
 }
 return{update,reload(){if(current)update(current,true);},dispose(){dispose?.();},getContext:()=>current};
}
