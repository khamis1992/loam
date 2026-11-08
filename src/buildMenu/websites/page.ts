import { visibleBriefHtml } from '../planProvenance.js';
import { cartTotal, demoReply } from './demo.js';

export type WebsitePageKind = 'landing' | 'store' | 'booking' | 'chatbot';

const PRODUCTS = [
  { name: 'دفتر', price: 2500 },
  { name: 'قلم', price: 1200 },
  { name: 'حقيبة', price: 4500 },
] as const;

const SLOTS = ['2026-11-10T09:00', '2026-11-10T10:00', '2026-11-10T11:00'] as const;

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char));
}

export function websiteDocument(title: string, subtype: WebsitePageKind, brief = ''): string {
  const safe = escapeText(title);
  const note = visibleBriefHtml(brief);
  switch (subtype) {
    case 'landing':
      return document(safe, `${note}${landingBody(safe)}`);
    case 'store':
      return document(safe, `${note}${storeBody()}`);
    case 'booking':
      return document(safe, `${note}${bookingBody()}`);
    case 'chatbot':
      return document(safe, `${note}${chatBody()}`);
    default: {
      const unknown: never = subtype;
      throw new Error(String(unknown));
    }
  }
}

function storeBody(): string {
  const items = PRODUCTS.map((item) => `<li>${item.name} <span>${item.price}</span> <button type="button" data-sku="${item.name}">أضف</button></li>`).join('');
  const catalog = cartTotal(PRODUCTS.map((item) => item.price));
  return `<h1>متجر</h1><p>سلة محلية</p><ul>${items}</ul><p id="catalog">${catalog}</p><p id="total">0</p><p id="out"></p><textarea id="state" aria-label="حالة السلة"></textarea><button type="button" id="export">صدّر الحالة</button><button type="button" id="import">استورد الحالة</button><script>${storeScript()}</script>`;
}

function storeScript(): string {
  const prices = Object.fromEntries(PRODUCTS.map((item) => [item.name, item.price]));
  return `const prices=${JSON.stringify(prices)};
function known(sku){return Object.prototype.hasOwnProperty.call(prices,sku);}
function recover(){document.getElementById('out').textContent='تعذرت قراءة السلة المحفوظة؛ بدأت سلة فارغة';}
function totalOf(items){
  if(!Array.isArray(items)||items.length>1000) throw new Error('bad');
  let total=0;
  for(const sku of items){
    if(!known(sku)) throw new Error('bad');
    total+=prices[sku];
    if(!Number.isSafeInteger(total)) throw new Error('bad');
  }
  return total;
}
function readCart(){
  const raw=localStorage.getItem('loam-store');
  if(!raw) return [];
  try {
    const parsed=JSON.parse(raw);
    totalOf(parsed);
    return parsed;
  } catch(error){recover();return [];}
}
let cart=readCart();
function render(){
  try {
    document.getElementById('total').textContent=String(totalOf(cart));
    localStorage.setItem('loam-store',JSON.stringify(cart));
  } catch(error){
    cart=[];
    recover();
    document.getElementById('total').textContent='0';
    localStorage.setItem('loam-store','[]');
  }
}
document.querySelectorAll('[data-sku]').forEach(function(button){
  button.onclick=function(){
    const sku=button.getAttribute('data-sku');
    if(!known(sku)){
      document.getElementById('out').textContent='هذا المنتج ليس في المتجر المحلي';
      return;
    }
    cart.push(sku);
    render();
  };
});
document.getElementById('export').onclick=function(){document.getElementById('state').value=JSON.stringify(cart);};
document.getElementById('import').onclick=function(){
  try {
    const parsed=JSON.parse(document.getElementById('state').value);
    totalOf(parsed);
    cart=parsed;
    document.getElementById('out').textContent='';
  } catch(error){cart=[];recover();}
  render();
};
render();`;
}

function landingBody(title: string): string {
  return `<h1>${title}</h1><p>صفحة هبوط محلية</p><button type="button" id="open">اطلب</button><form id="lead" hidden><input name="name" aria-label="الاسم"><button type="submit">أرسل</button></form><p id="out"></p><textarea id="state" aria-label="حالة الطلب"></textarea><button type="button" id="export">صدّر الحالة</button><button type="button" id="import">استورد الحالة</button><script>${landingScript()}</script>`;
}

function landingScript(): string {
  return `function recover(){document.getElementById('out').textContent='تعذرت قراءة الطلب المحفوظ؛ بدأ النموذج فارغاً';}
function acceptLead(parsed){
  if(typeof parsed!=='string'||parsed.trim().length===0||parsed.length>80) throw new Error('bad');
  return parsed;
}
function readLead(){
  const raw=localStorage.getItem('loam-lead');
  if(!raw) return '';
  try { return acceptLead(JSON.parse(raw)); }
  catch(error){recover();localStorage.removeItem('loam-lead');return '';}
}
const input=document.querySelector('input[name="name"]');
const saved=readLead();
if(saved){input.value=saved;document.getElementById('lead').hidden=false;}
document.getElementById('open').onclick=function(){document.getElementById('lead').hidden=false;};
document.getElementById('lead').onsubmit=function(event){
  event.preventDefault();
  const value=input.value.trim().slice(0,80);
  if(!value){document.getElementById('out').textContent='empty_message';return;}
  localStorage.setItem('loam-lead',JSON.stringify(value));
  document.getElementById('lead').hidden=false;
  document.getElementById('out').textContent='بقيت الرسالة على هذا الجهاز';
};
document.getElementById('export').onclick=function(){document.getElementById('state').value=JSON.stringify(input.value);};
document.getElementById('import').onclick=function(){
  try {
    const parsed=acceptLead(JSON.parse(document.getElementById('state').value));
    input.value=parsed;
    localStorage.setItem('loam-lead',JSON.stringify(parsed));
    document.getElementById('lead').hidden=false;
    document.getElementById('out').textContent='';
  } catch(error){
    input.value='';
    localStorage.removeItem('loam-lead');
    document.getElementById('lead').hidden=true;
    recover();
  }
};`;
}

function bookingBody(): string {
  const buttons = SLOTS.map((slot) => `<button type="button" data-slot="${slot}">${slot.slice(11)}</button>`).join('');
  return `<h1>حجز</h1><p>Asia/Qatar</p><p>محلي فقط</p>${buttons}<p id="out"></p><textarea id="state" aria-label="حالة الحجوزات"></textarea><button type="button" id="export">صدّر الحالة</button><button type="button" id="import">استورد الحالة</button><script>${bookingScript()}</script>`;
}

function bookingScript(): string {
  return `const allowed=${JSON.stringify(SLOTS)};
function recover(){document.getElementById('out').textContent='تعذرت قراءة الحجوزات المحفوظة؛ بدأت قائمة فارغة';}
function parseTaken(parsed){
  if(!Array.isArray(parsed)||parsed.length>allowed.length) throw new Error('bad');
  const seen={};
  for(let index=0;index<parsed.length;index+=1){
    const slot=parsed[index];
    if(allowed.indexOf(slot)===-1||seen[slot]) throw new Error('bad');
    seen[slot]=true;
  }
  return parsed;
}
function readTaken(){
  const raw=localStorage.getItem('loam-booking');
  if(!raw) return [];
  try { return parseTaken(JSON.parse(raw)); }
  catch(error){recover();return [];}
}
const taken=readTaken();
function save(){localStorage.setItem('loam-booking',JSON.stringify(taken));}
document.querySelectorAll('[data-slot]').forEach(function(button){
  button.onclick=function(){
    const slot=button.getAttribute('data-slot');
    const out=document.getElementById('out');
    if(allowed.indexOf(slot)===-1||!slot||slot.length>64){out.textContent='invalid_slot';return;}
    if(taken.indexOf(slot)!==-1){out.textContent='slot_taken';return;}
    taken.push(slot);
    save();
    out.textContent='تم الحفظ محلياً';
  };
});
document.getElementById('export').onclick=function(){document.getElementById('state').value=JSON.stringify(taken);};
document.getElementById('import').onclick=function(){
  try {
    const parsed=parseTaken(JSON.parse(document.getElementById('state').value));
    taken.length=0;
    for(let index=0;index<parsed.length;index+=1) taken.push(parsed[index]);
    document.getElementById('out').textContent='';
  } catch(error){
    taken.length=0;
    recover();
  }
  save();
};
save();`;
}

function chatBody(): string {
  return `<h1>دردشة</h1><form><input name="q" aria-label="رسالة"><button type="submit">أرسل</button></form><pre id="log"></pre><p id="out"></p><textarea id="state" aria-label="سجل المحادثة"></textarea><button type="button" id="export">صدّر الحالة</button><button type="button" id="import">استورد الحالة</button><script>${chatScript()}</script>`;
}

function chatScript(): string {
  const reply = JSON.stringify(demoReply('مرحبا'));
  return `const reply=${reply};
function recover(){document.getElementById('out').textContent='تعذرت قراءة المحادثة المحفوظة؛ بدأت محادثة فارغة';}
function known(line){return typeof line==='string'&&line.length<=500;}
function readLog(){
  const raw=localStorage.getItem('loam-chat');
  if(!raw) return [];
  try {
    const parsed=JSON.parse(raw);
    if(!Array.isArray(parsed)||parsed.length>40||parsed.some(function(line){return !known(line);})) throw new Error('bad');
    return parsed;
  } catch(error){recover();return [];}
}
let log=readLog();
function render(){
  document.getElementById('log').textContent=log.join('\\n');
  localStorage.setItem('loam-chat',JSON.stringify(log));
}
document.querySelector('form').onsubmit=function(event){
  event.preventDefault();
  const value=document.querySelector('input').value.trim().slice(0,500);
  if(!value){document.getElementById('out').textContent='empty_message';return;}
  log.push(value);
  log.push(reply);
  if(log.length>40) log.splice(0, log.length-40);
  document.getElementById('out').textContent=reply;
  render();
};
document.getElementById('export').onclick=function(){document.getElementById('state').value=JSON.stringify(log);};
document.getElementById('import').onclick=function(){
  try {
    const parsed=JSON.parse(document.getElementById('state').value);
    if(!Array.isArray(parsed)||parsed.length>40||parsed.some(function(line){return !known(line);})) throw new Error('bad');
    log=parsed;
    document.getElementById('out').textContent='';
  } catch(error){log=[];recover();}
  render();
};
render();`;
}

function document(title: string, body: string): string {
  const html = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>${title}</title>${body}</html>`;
  if (remoteDocument(html)) throw new Error('unsafe_path');
  return html;
}

function remoteDocument(html: string): boolean {
  if (/https?:\/\//i.test(html)) return true;
  if (/javascript\s*:/i.test(html)) return true;
  if (/(?:^|[\s.>])src\s*=\s*(?:["']\s*)?\/\//i.test(html)) return true;
  if (/(?:^|[\s.>]|&gt;)(?:src|href|action)\s*=\s*(?:(?:["']|&quot;)\s*)?(?:data|file|blob):/i.test(html)) return true;
  return contactScheme(html);
}

const CONTACT_SCHEME = /(?:mailto|tel|sms|intent|market)\s*:/i;

function contactScheme(html: string): boolean {
  let current = html;
  for (let depth = 0; depth < 3; depth += 1) {
    if (CONTACT_SCHEME.test(current) || CONTACT_SCHEME.test(joinQuoteSplits(current))) return true;
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

function joinQuoteSplits(value: string): string {
  const plain = value
    .replace(/&quot;/gi, '"')
    .replace(/&#x0*22;/gi, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&#0*39;/g, "'");
  return plain.replace(/['"`]\s*\+\s*['"`]/g, '').replace(/['"`]/g, '');
}
