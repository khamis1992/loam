import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MobileCollection } from '../../../ui/mobile-data.js';
import type { Block, MobileProject } from '../../mobile/store.js';
import { visibleBriefHtml } from '../planProvenance.js';
import { mobileNotice } from './notice.js';

const RECORD_RULES = fs.readFileSync(fileURLToPath(new URL('../../../ui/mobile-data.js', import.meta.url)), 'utf8').replace(/^export /gm, '');

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export function simulationDocument(project: MobileProject, brief = ''): string {
  const first = project.screens[0];
  if (!first) throw new Error('tool_failed');
  assertMobileNavigation(project);
  const known = new Set(project.screens.map((screen) => screen.id));
  const collections = project.collections ?? [];
  const sections = project.screens.map((screen) => {
    const hidden = screen.id === first.id ? '' : ' hidden';
    const parent = screen.kind === 'detail' && screen.parentId ? ` data-parent="${escapeText(screen.parentId)}"` : '';
    return `<section data-screen="${escapeText(screen.id)}"${parent}${hidden}><h1>${escapeText(screen.title)}</h1>${screen.blocks.map((block) => blockHtml(block, known, collections)).join('')}</section>`;
  }).join('');
  const navigation = project.screens.filter((screen) => screen.kind === 'primary').map((screen) => (
    `<button type="button" data-goto="${escapeText(screen.id)}">${escapeText(screen.title)}</button>`
  )).join('');
  const html = `<!doctype html><html lang="ar" dir="${pageDirection(project.direction)}" data-orientation="portrait"><meta charset="utf-8"><title>${escapeText(project.title)}</title><style>html[data-orientation="portrait"]{max-width:390px}html[data-orientation="landscape"]{max-width:844px}</style><p>${mobileNotice}</p>${visibleBriefHtml(brief)}<button type="button" id="back" hidden>رجوع</button><button type="button" id="rotate">تدوير المحاكاة</button><nav>${navigation}</nav>${sections}<div id="loam-collections" hidden>${escapeText(JSON.stringify(collections))}</div><script>
${RECORD_RULES}
const nodes=[].slice.call(document.querySelectorAll('[data-field]'));
const saved={};
try {
  const parsed=JSON.parse(localStorage.getItem('loam-sim')||'{}');
  if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)){
    nodes.forEach(function(node){
      const id=node.getAttribute('data-field');
      if(!id) return;
      if(node.type==='checkbox') saved[id]=parsed[id]===true;
      else if(typeof parsed[id]==='string') saved[id]=parsed[id].slice(0,500);
    });
  }
} catch (error) {}
localStorage.setItem('loam-sim', JSON.stringify(saved));
nodes.forEach(function(node){
  const id=node.getAttribute('data-field');
  if(!id) return;
  if(node.type==='checkbox'){
    node.checked=saved[id]===true;
    node.addEventListener('change',function(){saved[id]=node.checked===true;localStorage.setItem('loam-sim',JSON.stringify(saved));});
  }else{
    node.value=typeof saved[id]==='string'?saved[id]:'';
    node.addEventListener('input',function(){saved[id]=String(node.value).slice(0,500);node.value=saved[id];localStorage.setItem('loam-sim',JSON.stringify(saved));});
  }
});
var stack=[];
var current=null;
function known(id){
  var found=false;
  document.querySelectorAll('[data-screen]').forEach(function(node){ if(node.getAttribute('data-screen')===id) found=true; });
  return found;
}
function parentOf(id){
  var parent='';
  document.querySelectorAll('[data-screen]').forEach(function(node){
    if(node.getAttribute('data-screen')===id){
      var value=node.getAttribute('data-parent');
      if(typeof value==='string') parent=value;
    }
  });
  if(!parent || parent===id || !known(parent)) return '';
  return parent;
}
function show(id, fromBack){
  if(!known(id)) return;
  if(!fromBack && current && current!==id) stack.push(current);
  if(stack.length>20) stack=stack.slice(stack.length-20);
  current=id;
  document.querySelectorAll('[data-screen]').forEach(function(node){ node.hidden=node.getAttribute('data-screen')!==id; });
  var back=document.getElementById('back');
  if(back) back.hidden=stack.length===0 && !parentOf(id);
  try {
    localStorage.setItem('loam-sim-screen', id);
    localStorage.setItem('loam-sim-stack', JSON.stringify(stack));
  } catch (error) {}
}
var start=${JSON.stringify(first.id)};
try {
  var remembered=localStorage.getItem('loam-sim-screen');
  if(typeof remembered==='string' && known(remembered)) start=remembered;
  var savedStack=JSON.parse(localStorage.getItem('loam-sim-stack')||'[]');
  if(Array.isArray(savedStack)){
    savedStack.forEach(function(id){ if(typeof id==='string' && known(id) && stack.length<20) stack.push(id); });
    while(stack.length&&stack[stack.length-1]===start) stack.pop();
  }
} catch (error) { stack=[]; }
show(start, true);
var backButton=document.getElementById('back');
if(backButton) backButton.addEventListener('click', function(){
  var previous=stack.pop() || parentOf(current);
  if(previous && previous!==current) show(previous, true);
});
function applyOrientation(value){
  var next=value==='landscape'?'landscape':'portrait';
  if(document.documentElement&&document.documentElement.setAttribute) document.documentElement.setAttribute('data-orientation', next);
  try { localStorage.setItem('loam-sim-orientation', next); } catch (error) {}
}
var storedOrientation='';
try { storedOrientation=localStorage.getItem('loam-sim-orientation')||''; } catch (error) { storedOrientation=''; }
applyOrientation(storedOrientation);
var rotateButton=document.getElementById('rotate');
if(rotateButton&&rotateButton.addEventListener) rotateButton.addEventListener('click', function(){
  applyOrientation(document.documentElement.getAttribute('data-orientation')==='landscape'?'portrait':'landscape');
});
document.querySelectorAll('[data-goto]').forEach(function(node){
  var target=node.getAttribute('data-goto');
  if(!target) return;
  node.addEventListener('click', function(){ show(target); });
});
var schemas=[];
try {
  var schemaNode=document.getElementById('loam-collections');
  var parsedSchemas=schemaNode?JSON.parse(schemaNode.textContent||'[]'):[];
  if(Array.isArray(parsedSchemas)) schemas=parsedSchemas;
} catch (error) { schemas=[]; }
var records={version:1,revision:0,collections:{}};
try { records=parseRecordState(localStorage.getItem('loam-sim-records')); } catch (error) { records={version:1,revision:0,collections:{}}; }
function saveRecords(){ localStorage.setItem('loam-sim-records', JSON.stringify(records)); }
function rowsOf(id){ var list=records.collections?records.collections[id]:[]; return Array.isArray(list)?list.filter(function(row){ return row&&!row.deletedAt; }):[]; }
function paint(id){
  var root=document.querySelector('[data-collection="'+id+'"]');
  if(!root||!root.querySelector) return;
  var schema=schemas.find(function(item){ return item.id===id; });
  var titleField=schema?schema.titleField:'';
  var query=(root.querySelector('[data-search]')||{}).value||'';
  var box=root.querySelector('[data-rows]');
  if(!box) return;
  box.textContent='';
  rowsOf(id).filter(function(row){
    var title=row&&row.values?String(row.values[titleField]||''):'';
    return title.indexOf(query)!==-1;
  }).forEach(function(row){
    var item=document.createElement('li');
    item.textContent=String(row.values[titleField]||'');
    var edit=document.createElement('button');
    edit.type='button';
    edit.textContent='تعديل';
    edit.addEventListener('click', function(){ fill(root, row); });
    var remove=document.createElement('button');
    remove.type='button';
    remove.textContent='حذف';
    remove.addEventListener('click', function(){
      try {
        var result=mutateRecords(records, schemas, {type:'delete', collectionId:id, id:row.id, expectedUpdatedAt:row.updatedAt});
        records=result.state;
        saveRecords();
        paint(id);
      } catch (error) {
        var note=root.querySelector('[data-error]');
        if(note) note.textContent=error&&error.message?error.message:'تعذر الحذف';
      }
    });
    item.appendChild(edit);
    item.appendChild(remove);
    box.appendChild(item);
  });
  refreshRelations();
}
function refreshRelations(){
  document.querySelectorAll('[data-relation]').forEach(function(node){
    if(!node || node.tagName!=='SELECT') return;
    var current=node.value;
    var collectionId=node.getAttribute('data-relation');
    var schema=schemas.find(function(item){ return item.id===collectionId; });
    var titleField=schema?schema.titleField:'';
    node.textContent='';
    var empty=document.createElement('option');
    empty.value='';
    empty.textContent='';
    node.appendChild(empty);
    rowsOf(collectionId).forEach(function(row){
      var option=document.createElement('option');
      option.value=row.id;
      option.textContent=String(row.values&&titleField?row.values[titleField]||row.id:row.id);
      node.appendChild(option);
    });
    node.value=[].some.call(node.options, function(option){ return option.value===current; })?current:'';
  });
}
function fill(root, row){
  var form=root.querySelector('form');
  if(!form) return;
  form.querySelectorAll('[data-col-field]').forEach(function(node){
    var key=node.getAttribute('data-col-field');
    var value=row.values?row.values[key]:'';
    if(node.type==='checkbox') node.checked=value===true||value==='true';
    else node.value=value===undefined||value===null?'':String(value);
  });
    var editing=form.querySelector('[data-editing]');
    if(editing) editing.value=row.id;
    var stamp=form.querySelector('[data-updated]');
    if(stamp) stamp.value=row.updatedAt||'';
  }
document.querySelectorAll('[data-collection]').forEach(function(root){
  if(!root.querySelector) return;
  var id=root.getAttribute('data-collection');
  if(!id) return;
  var form=root.querySelector('form');
  var search=root.querySelector('[data-search]');
  if(search) search.addEventListener('input', function(){ paint(id); });
  if(!form) return;
  form.addEventListener('submit', function(event){
    event.preventDefault();
    var schema=schemas.find(function(item){ return item.id===id; });
    if(!schema) return;
    var values={};
    var missing=false;
    schema.fields.forEach(function(field){
      var node=form.querySelector('[data-col-field="'+field.id+'"]');
      if(!node) return;
      if(node.type==='checkbox') values[field.id]=node.checked;
      else {
        values[field.id]=String(node.value);
        if(field.id===schema.titleField && field.required && !String(node.value).trim()) missing=true;
      }
    });
    var error=root.querySelector('[data-error]');
    if(missing){ if(error) error.textContent='العنوان مطلوب'; return; }
    var editing=form.querySelector('[data-editing]');
    var stamp=form.querySelector('[data-updated]');
    var current=editing?editing.value:'';
    try {
      var result=mutateRecords(records, schemas, {type:'save', collectionId:id, ...(current?{id:current, expectedUpdatedAt:stamp?stamp.value:''}:{}) , values:values});
      var messages=Object.keys(result.errors);
      if(messages.length){ if(error) error.textContent=result.errors[messages[0]]; return; }
      records=result.state;
    } catch (failure) {
      if(error) error.textContent=failure&&failure.message?failure.message:'تعذر الحفظ';
      return;
    }
    if(error) error.textContent='';
    saveRecords();
    form.reset();
    if(editing) editing.value='';
    if(stamp) stamp.value='';
    paint(id);
  });
  paint(id);
});
</script></html>`;
  assertSafeSimulation(html);
  return html;
}

const HANDSET_SCHEME = /(?<![a-z])(?:mailto|tel|sms|intent|market)\s*:/;

function assertSafeSimulation(html: string): void {
  if (html.includes('postMessage')) throw new Error('unsafe_path');
  if (/['"]\*['"]/.test(html) || /\\+['"]\*\\+['"]/.test(html)) throw new Error('unsafe_path');
  const text = html.replaceAll('"http://www.w3.org/2000/svg"', '""').replaceAll("'http://www.w3.org/2000/svg'", "''");
  if (/https?:\/\//i.test(text) || /javascript\s*:/i.test(text)) throw new Error('unsafe_path');
  if (/<script\b[^>]*\ssrc\s*=/i.test(text)) throw new Error('unsafe_path');
  if (/(?:\ssrc|\shref|\saction)\s*=\s*\\*['"]*\s*(?:\/\/|\.\.\/|\.\.\\|file:|data:|blob:)/i.test(text)) {
    throw new Error('unsafe_path');
  }
  if (handsetScheme(text)) throw new Error('unsafe_path');
}

function handsetScheme(value: string): boolean {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (HANDSET_SCHEME.test(current.toLowerCase())) return true;
    if (depth === 2) break;
    const decoded = decodePercentBytes(current);
    if (decoded === current) return false;
    current = decoded;
  }
  return false;
}

function decodePercentBytes(value: string): string {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  return value.replace(/%([0-9a-f]{2})/gi, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function blockHtml(block: Block, screens: ReadonlySet<string>, collections: readonly MobileCollection[]): string {
  const label = escapeText(block.text);
  const id = escapeText(block.id);
  switch (block.type) {
    case 'input':
      return `<label>${label}<input data-field="${id}"${block.placeholder ? ` placeholder="${escapeText(block.placeholder)}"` : ''}></label>`;
    case 'toggle':
      return `<label>${label}<input data-field="${id}" type="checkbox"></label>`;
    case 'heading':
      return `<h2>${label}</h2>`;
    case 'text':
      return `<p>${label}</p>`;
    case 'button':
      return block.target && screens.has(block.target)
        ? `<button type="button" data-goto="${escapeText(block.target)}">${label}</button>`
        : `<button type="button">${label}</button>`;
    case 'collection':
      return collectionHtml(block, collections);
    default: {
      const unknown: never = block.type;
      return unknown;
    }
  }
}

function collectionHtml(block: Block, collections: readonly MobileCollection[]): string {
  const schema = collections.find((item) => item.id === block.collectionId);
  if (!schema || !block.collectionId) return `<p>${escapeText(block.text)}</p>`;
  const fields = schema.fields.map((field) => {
    const name = escapeText(field.id);
    const caption = escapeText(field.label);
    switch (field.type) {
      case 'boolean':
        return `<label>${caption}<input data-col-field="${name}" type="checkbox"></label>`;
      case 'select':
        return `<label>${caption}<select data-col-field="${name}">${(field.options ?? []).map((option) => `<option>${escapeText(option)}</option>`).join('')}</select></label>`;
      case 'number':
        return `<label>${caption}<input data-col-field="${name}" type="number" step="any"></label>`;
      case 'date':
        return `<label>${caption}<input data-col-field="${name}" type="date"></label>`;
      case 'text':
        return `<label>${caption}<input data-col-field="${name}"></label>`;
      case 'relation':
        return `<label>${caption}<select data-col-field="${name}" data-relation="${escapeText(field.collectionId ?? '')}"></select></label>`;
      default: {
        const unknown: never = field.type;
        return unknown;
      }
    }
  }).join('');
  return `<div data-collection="${escapeText(block.collectionId)}"><p>${escapeText(block.text)}</p><input data-search placeholder="بحث"><ul data-rows></ul><p data-error role="alert"></p><form>${fields}<input data-editing type="hidden" value=""><input data-updated type="hidden" value=""><button type="submit">حفظ</button></form></div>`;
}

function assertMobileNavigation(project: MobileProject): void {
  const byId = new Map(project.screens.map((screen) => [screen.id, screen]));
  for (const screen of project.screens) {
    for (const block of screen.blocks) {
      if (block.target && !byId.has(block.target)) throw new Error('tool_failed');
    }
    if (screen.kind !== 'detail') continue;
    const seen = new Set<string>();
    let cursor: MobileProject['screens'][number] | undefined = screen;
    while (cursor?.kind === 'detail') {
      const parentId = cursor.parentId;
      if (!parentId || seen.has(cursor.id) || !byId.has(parentId)) throw new Error('tool_failed');
      seen.add(cursor.id);
      cursor = byId.get(parentId);
    }
  }
}

function pageDirection(value: string): 'rtl' | 'ltr' {
  if (value === 'rtl' || value === 'ltr') return value;
  throw new Error('unsafe_path');
}

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ESCAPE[char] ?? char);
}
