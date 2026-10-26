const $=id=>document.getElementById(id);
async function api(url,body,timeout=20000){const r=await fetch(url,{signal:AbortSignal.timeout(timeout),...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'تعذر الاتصال');return d;}
function msg(t){$('msg').textContent=t;}
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function icon(name){const i=document.createElement('loam-icon');i.setAttribute('name',name);return i;}
function btn(label,name,onclick){const b=el('button');b.type='button';b.append(icon(name),' '+label);b.onclick=onclick;return b;}
let status=null,tasks=[];

function row(dl,k,v){dl.append(el('dt',k),el('dd',v));}
async function loadStatus(){
  status=await api('/api/api-anything/status');const dl=$('status');dl.replaceChildren();
  row(dl,'التفعيل',status.enabled?'مفعّلة':'متوقفة');
  row(dl,'الجاهزية',status.readiness.ready?'جاهزة':({disabled:'متوقفة من الإعدادات','not-vendored':'الحزمة غير مثبتة','wrong-commit':'نسخة الحزمة لا تطابق النسخة المعتمدة','node-too-old':'إصدار Node في Loam أقدم من 22.13'}[status.readiness.reason]||status.readiness.reason));
  row(dl,'الخادم',status.server.connected?`متصل · ${status.server.toolCount} أدوات`:'غير متصل');
  row(dl,'Node',status.node||'—');
  row(dl,'المتصفح',status.browser?`${status.browser.name} · ${status.browser.bin}`:'لم يُعثر على متصفح Chromium');
  row(dl,'مجلد البيانات',status.home);
  row(dl,'صلاحيات المجلد',status.acl.length?status.acl.join(' · '):'—');
  row(dl,'النسخة',`${status.version} · ${status.commit.slice(0,7)}`);
  if(status.probeError)row(dl,'خطأ الفحص',status.probeError);
  $('restart').hidden=!status.restartRequired;
  $('enabled').checked=status.enabled;$('allowWrites').checked=status.settings.allowWrites;$('allowWriteLearning').checked=status.settings.allowWriteLearning;
  renderDomains();renderPeople();
}
function renderDomains(){const ul=$('domains');ul.replaceChildren();for(const d of status.settings.learnDomains){const li=el('li');li.append(el('span',d),btn('حذف','trash',async()=>{await saveSettings({learnDomains:status.settings.learnDomains.filter(x=>x!==d)});}));li.firstChild.dir='ltr';ul.append(li);}if(!status.settings.learnDomains.length)ul.append(el('li','لا نطاقات إضافية. المواقع المعروفة مسموحة تلقائيًا.','hint'));}
function renderPeople(){const id=$('peopleTask').value;$('peopleOn').disabled=!id;$('peopleOn').checked=!!id&&status.settings.peopleOpsTasks.includes(id);}
async function saveSettings(patch){const r=await api('/api/api-anything/settings',patch);msg(r.restartRequired?'حُفظ الإعداد. أعد تشغيل Loam لتطبيقه.':'حُفظ الإعداد.');await loadStatus();}

async function loadSites(){
  const box=$('sites');box.replaceChildren();if(!status.readiness.ready){box.append(el('p','فعّل واجهات المواقع لعرض المواقع.','hint'));return;}
  const {sites}=await api('/api/api-anything/sites');
  const table=el('table');const head=el('tr');for(const h of ['الموقع','المصدر','العمليات','الدخول',''])head.append(el('th',h));table.append(head);
  for(const s of sites){const tr=el('tr');const name=el('td');name.append(el('strong',s.displayName||s.site),el('small',' '+s.site));name.dir='auto';
    const ops=el('td',`${s.ops}${s.writes?` · ${s.writes} كتابة`:''}`);
    const login=el('td',s.loggedIn===undefined?'—':s.loggedIn?`مسجّل · ${s.cookieCount} كوكيز`:'غير مسجّل');
    const actions=el('td');
    actions.append(btn('العمليات','eye',()=>showOps(s.site,tr)),btn('تسجيل الدخول','forward',()=>login(s.site)),btn('خروج','close',()=>logout(s.site)),btn('تحقق','refresh',()=>verify(s.site)));
    tr.append(name,el('td',{user:'تعلّمته هنا',registry:'مشترك',bundled:'مرفق'}[s.source]||s.source),ops,login,actions);table.append(tr);}
  box.append(table);
}
async function showOps(site,tr){const {operations}=await api('/api/api-anything/ops?site='+encodeURIComponent(site));const next=tr.nextElementSibling;if(next?.classList.contains('ops'))return next.remove();const r=el('tr','', 'ops');const td=el('td');td.colSpan=5;const ul=el('ul');for(const o of operations){const li=el('li');li.dir='ltr';li.append(el('code',o.op),' ',el('span',o.params.join(', ')||'—'));if(!o.readOnly)li.append(' ',el('span','كتابة','pill error'));ul.append(li);}td.append(ul);r.append(td);tr.after(r);}
async function login(site){$('loginNote').hidden=false;msg('');try{const r=await api('/api/api-anything/login',{site},960000);msg(r.ok?`تم تسجيل الدخول إلى ${site}${r.cookies?` · ${r.cookies.length} كوكيز`:''}.`:(r.error||'لم يكتمل تسجيل الدخول.'));}finally{$('loginNote').hidden=true;await loadSites();}}
async function logout(site){if(!confirm(`حذف جلسة ${site} من Loam؟ ستحتاج إلى تسجيل الدخول مرة أخرى.`))return;await api('/api/api-anything/logout',{site});msg(`حُذفت جلسة ${site}.`);await loadSites();}
async function verify(site){msg(`جارٍ التحقق من ${site}…`);const r=await api('/api/api-anything/verify',{site},330000);msg(`انتهى التحقق من ${site}${r.ok===false?' مع أخطاء':''}.`);await loadSites();}

async function loadAudit(){const {lines}=await api('/api/api-anything/audit?limit=50');const ol=$('audit');ol.replaceChildren();for(const l of lines){const li=el('li');li.dir='ltr';li.textContent=`${new Date(l.at).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'})} · ${l.tool}${l.site?' · '+l.site:''}${l.op?'.'+l.op:''} · ${l.decision}${l.class?' · '+l.class:''}${l.tier?' · tier '+l.tier:''}`;ol.append(li);}if(!lines.length)ol.append(el('li','لا استخدام بعد.','hint'));}

async function loadTasks(){const r=await api('/api/tasks');tasks=(r.tasks||[]).filter(t=>t.mode!=='ask');for(const sel of [$('peopleTask'),$('grantTask')]){for(const t of tasks)sel.add(new Option(t.title||t.id,t.id));}}

$('refresh').onclick=()=>init().catch(e=>msg(e.message));
for(const k of ['enabled','allowWrites','allowWriteLearning'])$(k).onchange=async e=>{if(k!=='enabled'&&e.target.checked&&!confirm('ستتمكن العمليات من تعديل حساباتك على هذه المواقع (نشر أو شراء أو حذف) بعد موافقتك على كل عملية. هل تريد المتابعة؟')){e.target.checked=false;return;}await saveSettings({[k]:e.target.checked}).catch(err=>msg(err.message));};
$('domainForm').onsubmit=async e=>{e.preventDefault();const d=$('domain').value.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,'');await saveSettings({learnDomains:[...new Set([...status.settings.learnDomains,d])]}).catch(err=>msg(err.message));$('domain').value='';};
$('peopleTask').onchange=renderPeople;
$('peopleOn').onchange=async e=>{const id=$('peopleTask').value;const set=new Set(status.settings.peopleOpsTasks);if(e.target.checked)set.add(id);else set.delete(id);await saveSettings({peopleOpsTasks:[...set]}).catch(err=>msg(err.message));};
$('grantTask').onchange=()=>{$('grant').disabled=!$('grantTask').value;};
$('grant').onclick=async()=>{try{const r=await api('/api/api-anything/grant',{taskId:$('grantTask').value});msg(`فُعّلت ${r.enabled.length} أداة لهذه المهمة.`);}catch(e){msg(e.message);}};
$('learnForm').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{
  const url=new URL(String(f.get('url')));if(url.protocol!=='https:')throw Error('الرابط يجب أن يبدأ بـ https');
  const host=url.hostname.toLowerCase();if(!status.settings.learnDomains.includes(host))await saveSettings({learnDomains:[...status.settings.learnDomains,host]});
  const {task}=await api('/api/tasks/draft',{mode:'automate',title:`تعلّم ${f.get('site')}.${f.get('op')}`});
  await api('/api/api-anything/grant',{taskId:task.id});
  const [k1,v1]=String(f.get('example')).split('=');const [k2,v2]=String(f.get('example2')).split('=');
  $('learnPrompt').textContent=`Learn an api-anything operation for me. Site: ${f.get('site')}. Operation: ${f.get('op')}. Page: ${url.href}. Example value: ${k1}=${v1}. Second example: ${k2}=${v2}. Use integration_call api_capture with outline, read the candidates, then api_add with the trigger URL using {${k1}} and both examples, then call it once with mcp__api-anything__call_operation and show me the result. Read only; do not learn any write.`;
  $('openTask').href='/#/tasks/'+encodeURIComponent(task.id);$('learnOut').hidden=false;msg('');
}catch(err){msg(err.message);}};
$('copyPrompt').onclick=()=>navigator.clipboard.writeText($('learnPrompt').textContent).then(()=>msg('نُسخ الطلب.'));
async function init(){await loadStatus();await loadSites();await loadAudit();}
try{await loadTasks();await init();}catch(e){msg(e.message);}
