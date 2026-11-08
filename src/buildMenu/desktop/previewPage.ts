import { visibleBriefHtml } from '../planProvenance.js';

export function desktopPreviewHtml(brief = ''): string {
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:"><title>ملاحظة</title>${visibleBriefHtml(brief)}<h1>ملاحظة محلية</h1><textarea id="note" aria-label="ملاحظة"></textarea><p id="empty">لا توجد ملاحظة بعد</p><p id="save-error" hidden></p><textarea id="export" hidden aria-label="نسخة النص"></textarea><script src="./preview.js"></script></html>`;
}

export function desktopPreviewScript(): string {
  return `const note=document.querySelector('#note');
const error=document.querySelector('#save-error');
const exported=document.querySelector('#export');
const empty=document.querySelector('#empty');
const key='loam-desktop-note';
const bridge=typeof desktop==='undefined'?null:desktop;
function noteBytes(value){return unescape(encodeURIComponent(value)).length;}
function showDenied(){
  error.hidden=false;
  error.textContent='تعذر الحفظ على هذا الجهاز. انسخ النص من المربع.';
  exported.hidden=false;
  exported.value=note.value;
  empty.hidden=true;
}
function showEmpty(){empty.hidden=note.value.trim().length>0;}
function saved(){
  error.hidden=true;
  exported.hidden=true;
  showEmpty();
}
const slash=String.fromCharCode(47);
const colon=String.fromCharCode(58);
const pair=slash+slash;
const remoteScheme=new RegExp('https?'+colon+pair+'|javascript'+colon+'|data'+colon+'|file'+colon+'|blob'+colon+'|mailto'+colon+'|tel'+colon+'|sms'+colon+'|intent'+colon+'|market'+colon+'|(^|[^'+colon+'])'+pair,'i');
function isQuote(code){return code===39||code===34||code===96;}
function isSpace(code){
  return code===9||code===10||code===11||code===12||code===13||code===32||code===160||code===5760||(code>=8192&&code<=8202)||code===8232||code===8233||code===8239||code===8287||code===12288||code===65279;
}
function stripSpace(value){
  const parts=[];
  let spaced=false;
  for(let index=0;index<value.length;index+=1){
    if(isSpace(value.charCodeAt(index))){spaced=true;continue;}
    parts.push(value.charAt(index));
  }
  return spaced?parts.join(''):value;
}
function stripQuotePlus(value){
  const parts=[];
  for(let index=0;index<value.length;index+=1){
    if(!isQuote(value.charCodeAt(index))){parts.push(value.charAt(index));continue;}
    let next=index+1;
    while(next<value.length&&isSpace(value.charCodeAt(next))) next+=1;
    if(next>=value.length||value.charCodeAt(next)!==43){parts.push(value.charAt(index));continue;}
    next+=1;
    while(next<value.length&&isSpace(value.charCodeAt(next))) next+=1;
    if(next<value.length&&isQuote(value.charCodeAt(next))){index=next;continue;}
    parts.push(value.charAt(index));
  }
  return parts.join('');
}
function collapseQuotePlus(value){
  let current=value;
  let previous;
  do{
    previous=current;
    current=stripQuotePlus(current);
  }while(current!==previous);
  return current;
}
function stripMarks(value){
  const parts=[];
  for(let index=0;index<value.length;index+=1){
    const code=value.charCodeAt(index);
    if(code===34||code===39||code===43||code===96) continue;
    parts.push(value.charAt(index));
  }
  return parts.join('');
}
function remoteForms(value){
  const collapsed=collapseQuotePlus(value);
  const opened=stripMarks(collapsed);
  const forms=[value];
  if(collapsed!==value) forms.push(collapsed);
  if(opened!==value&&opened!==collapsed) forms.push(opened);
  return forms;
}
function matchesScheme(value){
  if(remoteScheme.test(value)) return true;
  const compact=stripSpace(value);
  return compact!==value&&remoteScheme.test(compact);
}
function decodePercent(value){
  return value.replace(/%([0-9A-Fa-f]{2})/g,function(_whole,hex){return String.fromCharCode(Number.parseInt(hex,16));});
}
function formIsRemote(value){
  const forms=remoteForms(value);
  for(let index=0;index<forms.length;index+=1){
    if(matchesScheme(forms[index])) return true;
  }
  return false;
}
function remoteNotes(text){
  let pending=[text];
  const seen=new Set();
  for(let depth=0;depth<=2;depth+=1){
    const layer=pending;
    pending=[];
    for(let index=0;index<layer.length;index+=1){
      const value=layer[index];
      if(seen.has(value)) continue;
      seen.add(value);
      if(formIsRemote(value)) return true;
      if(depth>=2) continue;
      const decoded=decodePercent(value);
      if(decoded!==value) pending.push(decoded);
      const decodedCollapsed=decodePercent(collapseQuotePlus(value));
      if(decodedCollapsed!==value&&decodedCollapsed!==decoded) pending.push(decodedCollapsed);
    }
  }
  return false;
}
function save(){
  if(noteBytes(note.value)>65536){showDenied();return;}
  if(remoteNotes(note.value)){showDenied();return;}
  if(bridge&&typeof bridge.saveNotes==='function'){
    Promise.resolve(bridge.saveNotes(note.value)).then(saved).catch(showDenied);
    return;
  }
  try{
    localStorage.setItem(key,note.value);
    saved();
  }catch(e){showDenied();}
}
if(bridge&&typeof bridge.loadNotes==='function'){
  Promise.resolve(bridge.loadNotes()).then(function(text){
    if(note.value) return;
    note.value=typeof text==='string'?text:'';
    saved();
  }).catch(showDenied);
}else{
  try{note.value=localStorage.getItem(key)||'';}catch(e){showDenied();}
  showEmpty();
}
note.addEventListener('input',save);
document.addEventListener('keydown',function(event){
  if((event.ctrlKey||event.metaKey)&&String(event.key).toLowerCase()==='s'){
    event.preventDefault();
    save();
  }
});
`;
}
