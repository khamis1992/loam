export function mountAppUpdates({confirm}){
 const card=document.createElement('section');card.className='settings-card app-updates';card.setAttribute('aria-label','تحديث التطبيق');
 card.innerHTML='<div class="update-heading"><div><h2>تحديث التطبيق</h2><p data-update-version class="muted">جارٍ قراءة الإصدار…</p></div><span data-update-badge></span></div><p data-update-status role="status" aria-live="polite"></p><progress data-update-progress max="100" hidden aria-label="تنزيل التحديث"></progress><div class="update-actions"><button class="btn" type="button" data-update-check>التحقق من التحديثات</button><button class="primary" type="button" data-update-install hidden>تثبيت وإعادة التشغيل</button></div><p class="muted" data-update-help></p>';
 document.querySelector('#serviceLinks').before(card);
 const api=window.loam?.updates,check=card.querySelector('[data-update-check]'),install=card.querySelector('[data-update-install]'),status=card.querySelector('[data-update-status]'),progress=card.querySelector('progress');let busy=false;
 const labels={idle:'اضغط للتحقق من آخر إصدار منشور.',checking:'جارٍ التحقق من التحديثات…',available:'يتوفر تحديث جديد. جارٍ بدء التنزيل…',downloading:'جارٍ تنزيل التحديث…',downloaded:'التحديث جاهز للتثبيت.',current:'أنت تستخدم أحدث إصدار منشور على قناة التحديث.',installing:'جارٍ تثبيت التحديث وإعادة تشغيل Loam…',disabled:'التحديث متاح من النسخة المثبتة من Loam.'};
 const render=value=>{
  card.querySelector('[data-update-version]').textContent='الإصدار الحالي: '+(value.currentVersion||'—');
  card.querySelector('[data-update-badge]').textContent=value.version&&value.state!=='current'?'الإصدار '+value.version:'';
  status.textContent=value.state==='current'?(value.localChannel?'الإصدار المثبت يطابق آخر إصدار منشور محليًا.':'الإصدار المثبت يطابق آخر إصدار على القناة المحددة.'):value.state==='channel-mismatch'?'القناة تعرض إصدارًا مختلفًا ولا توفر ترقية أحدث متوافقة.':value.state==='error'?(value.localChannel?'تعذّر الوصول إلى إصدار منشور. أعد المحاولة بعد نشر التحديث المحلي.':'تعذّر التحقق. تحقق من اتصالك ثم أعد المحاولة.'):(labels[value.state]||labels.idle);
  const loading=['checking','available','downloading','installing'].includes(value.state);
  check.disabled=busy||loading||value.state==='downloaded'||value.state==='disabled';install.hidden=value.state!=='downloaded';install.disabled=busy;
  progress.hidden=value.state!=='downloading';progress.value=Math.max(0,Math.min(100,Number(value.percent)||0));
  if(value.state==='downloading')status.textContent+=' '+Math.round(progress.value)+'%';
  card.querySelector('[data-update-help]').textContent=(value.localChannel?'المصدر: قناة محلية على هذا الجهاز، وليست خدمة تحديث عبر الإنترنت. تصل تعديلات التطوير بعد حزمها ونشرها برقم إصدار جديد.':'المصدر: قناة التحديث المحددة.')+(value.version?' الإصدار المنشور: '+value.version+'.':'')+(value.checkedAt?' آخر فحص: '+new Date(value.checkedAt).toLocaleString('ar-SA')+'.':'');
 };
 if(!api){check.disabled=true;status.textContent='افتح Loam من التطبيق المثبت للتحقق من التحديثات وتثبيتها.';fetch('/api/identity').then(r=>r.json()).then(v=>{card.querySelector('[data-update-version]').textContent='الإصدار الحالي: '+v.version;}).catch(()=>{});return;}
 const refresh=async()=>{if(busy||location.hash!=='#/services'||document.hidden)return;try{render(await api.status());}catch{status.textContent='تعذّر الاتصال بخدمة التحديث. أعد فتح Loam.';}};
 check.onclick=async()=>{busy=true;check.disabled=true;status.textContent=labels.checking;try{render(await api.check());}catch{status.textContent='تعذّر بدء التحقق. أعد المحاولة.';}finally{busy=false;await refresh();}};
 install.onclick=async()=>{
  if(busy)return;
  if(!await confirm('تثبيت التحديث','سيُغلق Loam ويُعاد تشغيله. احفظ تعديلاتك قبل المتابعة.'))return;
  busy=true;install.disabled=true;
  try{await api.install();status.textContent=labels.installing;}catch(error){status.textContent=error.message.replace(/^.*Error: /,'');busy=false;install.disabled=false;}
 };
 window.addEventListener('hashchange',()=>void refresh());setInterval(()=>void refresh(),1500);void api.status().then(render).catch(()=>{});
}
