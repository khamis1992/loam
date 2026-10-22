import {reflowSegments,formatRange,cutSegments,segmentAt,normalizeSegments} from './inline-segments.js';
let current;
const send=data=>parent.postMessage(data,'*');
export const caretBusy=()=>!!current;
export function caretError(message){if(!current)return false;current.pending=false;current.editor.contentEditable='plaintext-only';current.toolbar.querySelectorAll('button,input,select').forEach(b=>b.disabled=false);current.status.textContent=message;return true;}
function finish(){if(!current)return;current.dispose?.();current.editor.remove();current.toolbar.remove();current=null;send({type:'loam-preview-editing',editing:false});}
function valueAt(block,path,value){const [kind,a,b]=path.split('/');if(kind==='text'){if(value!==undefined)block.text=value;return block.text;}if(kind==='column'){if(value!==undefined)block.columns[+a]=value;return block.columns[+a];}if(kind==='cell'){if(value!==undefined)block.rows[+a][+b]=value;return block.rows[+a][+b];}if(kind==='stat'){if(value!==undefined)block.items[+a][b]=value;return block.items[+a][b];}}
function submit(operation){const a=current;a.pending=true;a.editor.contentEditable='false';a.toolbar.querySelectorAll('button,input,select').forEach(b=>b.disabled=true);a.status.textContent='جارٍ الحفظ وإعادة توزيع Word…';send({type:'loam-preview-commit',revision:a.artifact.revision,scrollY:window.scrollY,operation});}
const highlights={yellow:'#ffff00',green:'#00ff00',cyan:'#00ffff',magenta:'#ff00ff',blue:'#0000ff',red:'#ff0000',darkBlue:'#00008b',darkCyan:'#008b8b',darkGreen:'#006400',darkMagenta:'#8b008b',darkRed:'#8b0000',darkYellow:'#8b8000',darkGray:'#a9a9a9',lightGray:'#d3d3d3',black:'#000000',white:'#ffffff'};
const highlightNames={yellow:'أصفر',green:'أخضر',cyan:'سماوي',magenta:'أرجواني',blue:'أزرق',red:'أحمر',darkBlue:'أزرق داكن',darkCyan:'سماوي داكن',darkGreen:'أخضر داكن',darkMagenta:'أرجواني داكن',darkRed:'أحمر داكن',darkYellow:'أصفر داكن',darkGray:'رمادي داكن',lightGray:'رمادي فاتح',black:'أسود',white:'أبيض'};
export function openCaret(artifact,index,path,section,event,insert){
 if(current)return;
 const block=artifact.content.blocks[index],targets=[...section.querySelectorAll(`[data-target="${index}/${path}"]`)];
 if(!targets.length)return;
 const page=section.getBoundingClientRect(),rects=targets.map(t=>t.getBoundingClientRect());
 const left=Math.min(...rects.map(r=>r.left))-page.left,top=Math.min(...rects.map(r=>r.top))-page.top,right=Math.max(...rects.map(r=>r.right))-page.left,bottom=Math.max(...rects.map(r=>r.bottom))-page.top;
 const editor=document.createElement('div');editor.className='word-caret-editor';editor.contentEditable='plaintext-only';editor.setAttribute('role','textbox');editor.setAttribute('aria-label','الكتابة داخل السطر');editor.setAttribute('aria-multiline','true');editor.spellcheck=false;
 const source=valueAt(block,path)||'',segments=path==='text'&&block.segments?structuredClone(block.segments):undefined;
 const font=block.style||{},scale=page.width/Number(section.dataset.pointWidth),fontSize=(Number(targets[0].dataset.fontSize)||Number(font.fontSize)||11)*scale;
 Object.assign(editor.style,{left:left-3+'px',top:top+'px',width:Math.max(right-left+22,Math.min(146,page.width-left-2))+'px',minHeight:(bottom-top)+'px',padding:'0 3px',fontFamily:font.fontFamily||'Arial',fontSize:fontSize+'px',lineHeight:'1.15',fontWeight:font.bold||block.bold?'bold':'normal',fontStyle:block.italic?'italic':'normal',color:font.color||'#18202b',textAlign:font.alignment==='both'?'justify':font.alignment||'left'});editor.dir=/[\u0590-\u08ff]/.test(source)?'rtl':'ltr';
 const toolbar=document.createElement('div');toolbar.className='word-caret-toolbar';
 const formatControls=path==='text'?`<span class="word-caret-format"><button data-caret-bold title="غامق للنص المحدد" aria-pressed="false">غامق</button><button data-caret-italic title="مائل للنص المحدد" aria-pressed="false">مائل</button><button data-caret-underline title="تسطير للنص المحدد" aria-pressed="false">تسطير</button><label>لون<input type="color" data-caret-color></label><button data-caret-color-clear title="إزالة تلوين التحديد">بدون لون</button><select data-caret-highlight aria-label="لون تظليل التحديد"><option value="">بدون تظليل</option>${Object.keys(highlights).map(name=>`<option value="${name}">${highlightNames[name]}</option>`).join('')}</select><label>حجم<input type="number" min="4" max="144" step="0.5" data-caret-size aria-label="حجم خط التحديد"></label><select data-caret-font aria-label="خط التحديد"><option value="">الخط الحالي</option><option>Arial</option><option>Calibri</option><option>Courier New</option><option>Georgia</option><option>Segoe UI</option><option>Tahoma</option><option>Times New Roman</option></select></span>`:'';
 toolbar.innerHTML=`<button data-caret-save>حفظ</button>${formatControls}<button data-caret-insert>إدراج عند المؤشر</button><button data-caret-cancel>إلغاء</button><span role="status"></span>`;Object.assign(toolbar.style,{left:Math.max(0,Math.min(left,page.width-460))+'px',top:'0px'});
 section.append(editor,toolbar);
 // The wrapped toolbar can be several rows tall: keep it fully above the paragraph, otherwise below it.
 toolbar.style.top=(top-toolbar.offsetHeight-8>=0?top-toolbar.offsetHeight-8:bottom+6)+'px';
 current={artifact,index,path,editor,toolbar,status:toolbar.querySelector('[role=status]'),pending:false,offset:source.length,segments,range:null,scale,font};send({type:'loam-preview-editing',editing:true});
 const session=current;
 const renderSegments=()=>{
  const restore=current.offset??0;editor.textContent='';
  for(const segment of current.segments||[]){
   const span=document.createElement('span');span.textContent=segment.text;
   span.style.fontWeight=segment.bold===true?'bold':segment.bold===false?'normal':'';
   span.style.fontStyle=segment.italic===true?'italic':segment.italic===false?'normal':'';
   span.style.textDecoration=segment.underline===true?'underline':segment.underline===false?'none':'';
   if(segment.color)span.style.color=segment.color;
   if(segment.highlight)span.style.background=highlights[segment.highlight]||'';
   if(segment.size)span.style.fontSize=(segment.size*scale)+'px';
   if(segment.font)span.style.fontFamily=segment.font;
   editor.append(span);
  }
  const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let position=0,node;
  while(node=walker.nextNode()){
   if(position+node.length>=restore){const range=document.createRange();range.setStart(node,Math.max(0,Math.min(restore-position,node.length)));range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return;}
   position+=node.length;
  }
  const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
 };
 const selectionState=()=>{const base=current.segments;if(!base)return null;if(current.range&&current.range.start!==current.range.end)return cutSegments(base,current.range.start,current.range.end);const at=current.offset?segmentAt(base,current.offset-1,false):0;return [base[at]];};
 const updateFormatState=()=>{
  const within=selectionState();if(!within)return;
  for(const [key,name] of [['bold','bold'],['italic','italic'],['underline','underline']]){
   const button=toolbar.querySelector(`[data-caret-${name}]`);if(button)button.setAttribute('aria-pressed',String(within.every(segment=>segment[key]===true)));
  }
 };
 const offsetOf=(container,offset)=>{
  const path=[];let node=container;while(node&&node!==editor){if(!node.parentNode)return;path.unshift([...node.parentNode.childNodes].indexOf(node));node=node.parentNode;}
  const clone=editor.cloneNode(true);clone.removeAttribute('role');clone.style.cssText='position:fixed;left:-10000px;top:0;white-space:pre-wrap;opacity:0;pointer-events:none';let endpoint=clone;for(const i of path)endpoint=endpoint.childNodes[i];
  const range=document.createRange();range.setStart(endpoint,Math.min(offset,endpoint.nodeType===3?endpoint.length:endpoint.childNodes.length));range.collapse(true);const marker='\uFDD0'+Math.random()+'\uFDD1';range.insertNode(document.createTextNode(marker));document.body.append(clone);const at=clone.innerText.indexOf(marker);clone.remove();return at<0?undefined:at;
 };
 const selectionOffset=()=>{const s=getSelection();if(current!==session||!s?.rangeCount||!editor.contains(s.focusNode))return;
  const focus=offsetOf(s.focusNode,s.focusOffset),anchor=s.anchorNode&&editor.contains(s.anchorNode)?offsetOf(s.anchorNode,s.anchorOffset):focus;
  if(focus===undefined)return;current.offset=focus;
  // A collapsed caret clears the target range; a selection moved to toolbar controls keeps the last one.
  current.range=anchor===undefined||anchor===focus?null:{start:Math.min(anchor,focus),end:Math.max(anchor,focus)};
  updateFormatState();};
 document.addEventListener('selectionchange',selectionOffset);session.dispose=()=>document.removeEventListener('selectionchange',selectionOffset);
 toolbar.onmousedown=e=>{selectionOffset();if(e.target.closest('button'))e.preventDefault();};
 editor.addEventListener('keyup',selectionOffset);editor.addEventListener('mouseup',selectionOffset);
 const baseSegments=()=>current.segments??[{text:editor.innerText.replace(/\r/g,'')}];
 const applyPatch=patch=>{
  if(current.pending)return;
  if(!current.range||current.range.start===current.range.end){current.status.textContent='حدّد النص الذي تريد تنسيقه داخل الفقرة.';return;}
  current.segments=formatRange(baseSegments(),current.range.start,current.range.end,patch);
  renderSegments();updateFormatState();
 };
 const toggleFormat=key=>{const within=current.segments?selectionState():null;if(!within)return applyPatch({[key]:true});applyPatch({[key]:!within.every(segment=>segment[key]===true)});};
 toolbar.querySelector('[data-caret-bold]')?.addEventListener('click',()=>toggleFormat('bold'));
 toolbar.querySelector('[data-caret-italic]')?.addEventListener('click',()=>toggleFormat('italic'));
 toolbar.querySelector('[data-caret-underline]')?.addEventListener('click',()=>toggleFormat('underline'));
 const colorInput=toolbar.querySelector('[data-caret-color]');
 if(colorInput){
  colorInput.onchange=()=>applyPatch({color:colorInput.value.toUpperCase()});
  toolbar.querySelector('[data-caret-color-clear]').onclick=()=>applyPatch({color:null});
  const highlightSelect=toolbar.querySelector('[data-caret-highlight]');
  highlightSelect.onchange=()=>applyPatch(highlightSelect.value?{highlight:highlightSelect.value}:{highlight:null});
  const sizeInput=toolbar.querySelector('[data-caret-size]');
  sizeInput.onchange=()=>{const value=Number(sizeInput.value);if(!Number.isFinite(value)||value<4||value>144){current.status.textContent='أدخل حجم خط بين 4 و144.';sizeInput.value='';return;}applyPatch({size:value});};
  const fontSelect=toolbar.querySelector('[data-caret-font]');
  fontSelect.onchange=()=>applyPatch(fontSelect.value?{font:fontSelect.value}:{font:null});
 }
 const insertPlainText=text=>{const s=getSelection();if(!s?.rangeCount||!editor.contains(s.anchorNode))return;const r=s.getRangeAt(0);r.deleteContents();const n=document.createTextNode(text.replace(/\r\n?/g,'\n'));r.insertNode(n);r.setStartAfter(n);r.collapse(true);s.removeAllRanges();s.addRange(r);selectionOffset();};
 editor.onpaste=e=>{e.preventDefault();insertPlainText(e.clipboardData.getData('text/plain'));};
 editor.addEventListener('input',()=>{if(current.segments)current.segments=reflowSegments(current.segments,editor.innerText.replace(/\r/g,''));selectionOffset();});
 const save=()=>{if(current.pending)return;const draft=structuredClone(block);valueAt(draft,path,editor.innerText.replace(/\r/g,''));if(path==='text'&&current.segments){const normalized=normalizeSegments(current.segments);if(normalized)draft.segments=normalized;else delete draft.segments;}submit({kind:'replace',index,block:draft});};
 toolbar.querySelector('[data-caret-save]').onclick=save;toolbar.querySelector('[data-caret-cancel]').onclick=()=>{if(!current.pending)finish();};
 toolbar.querySelector('[data-caret-insert]').onclick=()=>{if(path!=='text'){current.status.textContent='لإدراج عنصر مستقل، اختر موضعًا في فقرة المستند أو على الصفحة.';return;}if(current.pending)return;selectionOffset();const offset=current.offset,text=editor.innerText.replace(/\r/g,''),segments=current.segments,selection=getSelection(),range=selection?.rangeCount?selection.getRangeAt(0).cloneRange():null;session.dispose();editor.hidden=true;toolbar.hidden=true;current=null;const resume=()=>{current=session;editor.hidden=false;toolbar.hidden=false;document.addEventListener('selectionchange',selectionOffset);editor.focus();if(range){const s=getSelection();s.removeAllRanges();s.addRange(range);}send({type:'loam-preview-editing',editing:true});};insert(index,offset,section,top/page.height*100,{text,segments,resume});};
 editor.onkeydown=e=>{if(e.isComposing)return;if(e.key==='Escape'&&!current.pending){e.preventDefault();finish();}if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();save();}};
 if(segments)renderSegments();else editor.textContent=source;
 editor.focus();if(event){let range;const pos=document.caretPositionFromPoint?.(event.clientX,event.clientY);if(pos&&editor.contains(pos.offsetNode)){range=document.createRange();range.setStart(pos.offsetNode,pos.offset);}else{const found=document.caretRangeFromPoint?.(event.clientX,event.clientY);if(found&&editor.contains(found.startContainer))range=found;}if(range){range.collapse(true);const s=getSelection();s.removeAllRanges();s.addRange(range);selectionOffset();}}
 else if(segments){const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(range);selectionOffset();}
}

function dragPreview(section,bounds){
 const ghost=document.createElement('div');ghost.className='word-drag-ghost';
 Object.assign(ghost.style,{left:bounds.left+'%',top:bounds.top+'%',width:bounds.width+'%',height:bounds.height+'%'});
 const source=section.querySelector(':scope > canvas');
 if(source?.width&&source?.height){
  const snapshot=document.createElement('canvas');snapshot.setAttribute('aria-hidden','true');
  snapshot.width=Math.max(1,Math.round(source.width*bounds.width/100));snapshot.height=Math.max(1,Math.round(source.height*bounds.height/100));
  const context=snapshot.getContext('2d');
  if(context){context.drawImage(source,source.width*bounds.left/100,source.height*bounds.top/100,source.width*bounds.width/100,source.height*bounds.height/100,0,0,snapshot.width,snapshot.height);Object.assign(snapshot.style,{width:'100%',height:'100%',display:'block'});ghost.append(snapshot);}
 }
 section.append(ghost);return ghost;
}

export function attachDrag(artifact,index,section,bounds,isBusy,onError){
 const handle=document.createElement('button');handle.type='button';handle.className='word-drag-handle';handle.dataset.dragIndex=index;handle.textContent='✥';handle.title='اسحب لتغيير موضع العنصر داخل الصفحة أو إلى صفحة أخرى في Word';handle.setAttribute('aria-label','سحب '+(artifact.content.blocks[index].type==='image'?'الصورة':'البطاقات'));
 Object.assign(handle.style,{left:bounds.left+'%',top:Math.max(0,bounds.top-2)+'%'});section.append(handle);
 handle.title+=' · الأسهم للتحريك، Shift لخطوة أكبر، Enter للحفظ وEscape للإلغاء';
 // A corner handle resizes the element; the exact Word geometry refreshes after save.
 const resize=document.createElement('button');resize.type='button';resize.className='word-drag-handle word-resize-handle';resize.dataset.resizeIndex=index;resize.textContent='⤡';resize.title='اسحب لتغيير حجم العنصر (يحفظ النسبة)';resize.setAttribute('aria-label','تغيير حجم '+(artifact.content.blocks[index].type==='image'?'الصورة':'البطاقات'));
 Object.assign(resize.style,{left:Math.min(98,bounds.left+bounds.width)+'%',top:Math.min(98,bounds.top+bounds.height)+'%'});section.append(resize);
 resize.onpointerdown=e=>{
  if(e.button!==0||isBusy()||current)return;e.preventDefault();resize.setPointerCapture(e.pointerId);send({type:'loam-preview-editing',editing:true});
  const page=section.getBoundingClientRect(),pw=+section.dataset.pointWidth,draft=structuredClone(artifact.content.blocks[index]);
  const originX=draft.position?.x??(pw*bounds.left/100-(draft.type==='stats'?5:0));
  const originWidth=draft.position?.width||draft.frameWidth||pw*bounds.width/100;
  const box=document.createElement('div');box.className='word-drag-ghost';Object.assign(box.style,{left:bounds.left+'%',top:bounds.top+'%',width:bounds.width+'%',height:bounds.height+'%'});section.append(box);
  const startX=e.clientX;let width=originWidth;
  resize.onpointermove=move=>{if(move.pointerId!==e.pointerId)return;width=Math.max(24,Math.min(pw-originX,originWidth+pw*(move.clientX-startX)/page.width));box.style.width=Math.max(1,bounds.width*width/originWidth)+'%';box.style.height=Math.max(1,bounds.height*width/originWidth)+'%';};
  const finish=ok=>{box.remove();resize.onpointermove=null;resize.onpointerup=null;resize.onpointercancel=null;resize.onlostpointercapture=null;if(resize.hasPointerCapture(e.pointerId))resize.releasePointerCapture(e.pointerId);send({type:'loam-preview-editing',editing:false});if(ok&&Math.abs(width-originWidth)>=1){draft.position={...(draft.position||{}),x:originX,y:draft.position?.y??0,width:Math.round(width*10)/10};resize.disabled=true;onError(resize);send({type:'loam-preview-editing',editing:true});send({type:'loam-preview-commit',revision:artifact.revision,scrollY:window.scrollY,operation:{kind:'replace',index,block:draft}});}};
  const cancelKey=event=>{if(event.key==='Escape'){event.preventDefault();finish(false);}};
  document.addEventListener('keydown',cancelKey);resize.onpointercancel=()=>finish(false);resize.onlostpointercapture=()=>{};resize.onpointerup=event=>{if(event.pointerId!==e.pointerId)return;document.removeEventListener('keydown',cancelKey);finish(true);};
 };
 let keyboardMove;
 const stopKeyboard=()=>{if(!keyboardMove)return;keyboardMove.ghost.remove();keyboardMove=null;send({type:'loam-preview-editing',editing:false});};
 handle.onblur=stopKeyboard;
 handle.onkeydown=e=>{
  if(e.key==='Escape'&&keyboardMove){e.preventDefault();stopKeyboard();return;}
  if(e.key==='Enter'&&keyboardMove){e.preventDefault();const {draft,x,y,originX,originY}=keyboardMove;stopKeyboard();if(x===originX&&y===originY)return;draft.position={...(draft.position||{}),x,y};handle.disabled=true;onError(handle);send({type:'loam-preview-editing',editing:true});send({type:'loam-preview-commit',revision:artifact.revision,scrollY:window.scrollY,operation:{kind:'replace',index,block:draft}});return;}
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)||e.ctrlKey||e.metaKey||e.altKey||isBusy()||current)return;
  e.preventDefault();
  if(!keyboardMove){const draft=structuredClone(artifact.content.blocks[index]),pw=+section.dataset.pointWidth,ph=+section.dataset.pointHeight,originX=draft.position?.x??(pw*bounds.left/100-(draft.type==='stats'?5:0)),originY=draft.position?.y??(ph*bounds.top/100-(draft.type==='stats'?3:0)),ghost=dragPreview(section,bounds);keyboardMove={draft,pw,ph,originX,originY,x:originX,y:originY,ghost,width:draft.position?.width||draft.frameWidth||pw*bounds.width/100};send({type:'loam-preview-editing',editing:true});}
  const k=keyboardMove,step=e.shiftKey?10:1;k.x=Math.max(0,Math.min(Math.max(0,k.pw-k.width),k.x+(e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0)));k.y=Math.max(0,Math.min(k.ph*(1-bounds.height/100),k.y+(e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0)));const page=section.getBoundingClientRect();k.ghost.style.transform=`translate(${(k.x-k.originX)*page.width/k.pw}px,${(k.y-k.originY)*page.height/k.ph}px)`;
 };
 handle.onpointerdown=e=>{
  stopKeyboard();
  if(e.button!==0||isBusy()||current)return;e.preventDefault();handle.focus({preventScroll:true});send({type:'loam-preview-editing',editing:true});const page=section.getBoundingClientRect(),pointWidth=+section.dataset.pointWidth,pointHeight=+section.dataset.pointHeight,startX=e.clientX,startY=e.clientY;
  const ghost=dragPreview(section,bounds);handle.setPointerCapture(e.pointerId);
  const draft=structuredClone(artifact.content.blocks[index]),actualWidth=draft.position?.width||draft.frameWidth||pointWidth*bounds.width/100;
  const originX=draft.position?.x??(pointWidth*bounds.left/100-(draft.type==='stats'?5:0)),originY=draft.position?.y??(pointHeight*bounds.top/100-(draft.type==='stats'?3:0));
  let dx=0,dy=0,x=originX,y=originY,crossPage=null;
  const pages=[...document.querySelectorAll('.word-page')];
  const pageUnder=()=>pages.find(candidate=>{const rect=candidate.getBoundingClientRect();return rect.top<=startY+dy&&startY+dy<rect.bottom;})||null;
  const anchorIndexOn=(target,dropY)=>{const rect=target.getBoundingClientRect();const targets=[...target.querySelectorAll('[data-target]')].filter(t=>+t.dataset.target.split('/')[0]!==index&&t.dataset.target.endsWith('/text'));if(!targets.length)return null;const above=targets.filter(t=>{const r=t.getBoundingClientRect();return r.top+r.height/2<=dropY;});if(!above.length)return +targets.map(t=>+t.dataset.target.split('/')[0]).sort((a,b)=>a-b)[0];return +above.map(t=>+t.dataset.target.split('/')[0]).sort((a,b)=>a-b).pop()+1;};
  handle.onpointermove=move=>{if(move.pointerId!==e.pointerId)return;dx=move.clientX-startX;dy=move.clientY-startY;
   const hovered=pageUnder();crossPage=hovered&&hovered!==section?hovered:null;
   ghost.style.transform=`translate(${dx}px,${dy}px)`;
   if(crossPage){ghost.style.outline='3px solid #c2571a';}else{ghost.style.outline='';x=Math.max(0,Math.min(pointWidth-actualWidth,originX+pointWidth*dx/page.width));y=Math.max(0,Math.min(pointHeight*(1-bounds.height/100),originY+pointHeight*dy/page.height));}
  };
  const cancelKey=event=>{if(event.key==='Escape'){event.preventDefault();cleanup();}};
  const cleanup=()=>{ghost.remove();handle.onpointermove=null;handle.onpointerup=null;handle.onpointercancel=null;handle.onlostpointercapture=null;document.removeEventListener('keydown',cancelKey);if(handle.hasPointerCapture(e.pointerId))handle.releasePointerCapture(e.pointerId);send({type:'loam-preview-editing',editing:false});};
  document.addEventListener('keydown',cancelKey);handle.onpointercancel=cleanup;handle.onlostpointercapture=cleanup;
  handle.onpointerup=event=>{if(event.pointerId!==e.pointerId)return;cleanup();if(Math.abs(dx)+Math.abs(dy)<4)return;
   if(crossPage){
    const rect=crossPage.getBoundingClientRect(),pw=+crossPage.dataset.pointWidth,ph=+crossPage.dataset.pointHeight;
    const px=Math.max(0,Math.min(pw-actualWidth,(event.clientX-rect.left)*pw/rect.width)),py=Math.max(0,Math.min(ph-10,(event.clientY-rect.top)*ph/rect.height));
    const to=anchorIndexOn(crossPage,event.clientY);
    if(to===null){const notice=document.querySelector('#counter');if(notice)notice.textContent='اختر فقرة على الصفحة الجديدة لربط العنصر بها؛ هذه الصفحة استمرار لجدول.';return;}
    handle.disabled=true;onError(handle);send({type:'loam-preview-editing',editing:true});
    send({type:'loam-preview-commit',revision:artifact.revision,scrollY:window.scrollY,operation:{kind:'move',index,to,position:{x:Math.round(px*10)/10,y:Math.round(py*10)/10}}});
    return;
   }
   draft.position={...(draft.position||{}),x,y};handle.disabled=true;onError(handle);send({type:'loam-preview-editing',editing:true});send({type:'loam-preview-commit',revision:artifact.revision,scrollY:window.scrollY,operation:{kind:'replace',index,block:draft}});};
 };
}

