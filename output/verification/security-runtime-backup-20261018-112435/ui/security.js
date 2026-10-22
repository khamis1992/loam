const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {running:'جارٍ الفحص',completed:'اكتمل التقييم',partial:'تقييم جزئي — راجع التغطية',cancelled:'أُلغي التقييم',failed:'تعذر التنفيذ',interrupted:'انقطع التشغيل',pass:'اجتاز',finding:'ملاحظة أمنية',error:'تعذر الفحص',info:'معلومة'};
const names = {security_headers:'ترويسات الحماية',cookie_flags:'حماية ملفات الارتباط',server_banner:'إفصاح التقنيات',exposed_files:'الملفات المكشوفة',directory_listing:'عرض المجلدات',cors_policy:'سياسة CORS',http_methods:'طرق HTTP',tls_info:'شهادة واتصال TLS'};
let taskId='', run=null, runs=[], tab='findings', generation=0, timer, posting=false, openapi;
let capabilities;
const repairDrafts=new Map();
function executionPlan(){
  const browser=$('browserEnabled').checked;
  $('executionPlan').textContent=`الخطة الحالية: HTTP${browser?' + متصفح JavaScript':' فقط؛ المتصفح معطّل'}${browser&&$('loginSteps').value.trim()?' + خطوات دخول':''}${browser&&$('spaFlows').value.trim()?' + تدفقات SPA':''}${browser&&$('apiGrants').value.trim()?' + أصول API محددة':''}${browser&&$('postPaths').value.trim()?' + POST للمسارات المحددة':''}. ${$('source').checked?'المصدر: ملفات مساحة المهمة فقط. ':''}${$('dependencies').checked?'الاعتماديات: ملفات القفل في مساحة المهمة. ':''}مدة الحملة حد أقصى وليست زمن تشغيل إلزاميًا.`;
}
const lines=id=>$(id).value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
const authentication=()=>({bearer:$('bearer').value,cookie:$('cookie').value});
function browserOptions(){
  const accessAssertions=lines('accessAssertions').map(line=>{const parts=line.split('|').map(s=>s.trim());if(parts.length<2||parts.length>3||!parts[0]||!parts[1])throw Error('صيغة التحقق: المسار | العنصر المحمي | عنصر رفض الوصول');return {path:parts[0],selector:parts[1],deniedSelector:parts[2]||''};});
  return {enabled:$('browserEnabled').checked,domCanary:$('domCanary').checked,framing:$('framing').checked,screenshots:$('screenshots').checked,maxPages:Number($('browserPages').value),settleMs:Number($('settleMs').value),responseLimitBytes:Number($('responseLimitMb').value)*1000000,totalLimitBytes:Number($('totalLimitMb').value)*1000000,readinessTimeoutMs:Number($('readinessTimeoutMs').value),networkIdleTimeoutMs:Number($('networkIdleTimeoutMs').value),readySelector:$('readySelector').value.trim(),readyRoutes:JSON.parse($('readyRoutes').value||'[]'),accessAssertions,postPaths:lines('postPaths'),apiGrants:JSON.parse($('apiGrants').value||'[]'),followRedirects:$('followRedirects').checked,login:JSON.parse($('loginSteps').value||'[]'),flows:JSON.parse($('spaFlows').value||'[]'),accounts:JSON.parse($('testAccounts').value||'[]'),authorization:JSON.parse($('authorizationCases').value||'[]')};
}
function findingProofs(f){return (f.browserEvidenceIds||[]).map(id=>{const p=run.browser?.proofs.find(p=>p.id===id);return `<p>دليل المتصفح: <span class="mono">${esc(id)}</span>${p?.artifact?` · <a href="${esc(endpoint('/'+run.id+'/browser-evidence/'+id))}" target="_blank" rel="noopener">فتح اللقطة</a>`:''}</p>`;}).join('');}
function clearCredentials(){$('bearer').value='';$('cookie').value='';$('browserSecrets').value='';}
async function api(url, body) {
  const res=await fetch(url,{signal:AbortSignal.timeout(20000),...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
  const data=await res.json();if(!res.ok)throw Error(data.error||`HTTP ${res.status}`);return data;
}
const endpoint=(suffix='')=>'/api/security/assessments'+suffix+'?taskId='+encodeURIComponent(taskId);
function notice(text=''){$('message').textContent=text;}
const safely=fn=>(...args)=>Promise.resolve().then(()=>fn(...args)).catch(e=>notice(e.message));
function remember(){try{localStorage.setItem('loam-security-task',taskId);}catch{}}
function draw(){
  executionPlan();
  $('engineStatus').textContent=!taskId?'اختر مساحة للتحقق من ربط المحرك.':capabilities?.revision>=8?'الخادم يدعم المتصفح والدخول وSPA وPOST وإعادة الاختبار؛ تنفيذها يعتمد على الخيارات المحددة.':'الخادم لم يعلن توافق الميزات الجديدة؛ أعد تشغيل النسخة المحدثة قبل فحص المتصفح.';
  const d=run?.diagnostics;
  $('executionDiagnostics').hidden=!d;
  if(d){const moduleNames={api_origins:'طلبات API المنفصلة الناجحة',sessions:'الجلسات المثبتة',authorization:'حالات الصلاحيات المحسومة',http:'طلبات HTTP الأساسية',browser:'صفحات المتصفح',login:'تسجيل الدخول',flows:'تدفقات SPA',post:'طلبات POST',source:'ملفات المصدر',dependencies:'الحزم المقفلة'},states={incomplete:'نُفّذ جزئيًا',disabled:'غير مفعّل',executed:'نُفّذ',no_execution:'لم يُنفّذ على مدخلات',pending:'بانتظار التنفيذ'};
    $('executionDiagnostics').innerHTML=`<h2>ما الذي نُفّذ فعلًا؟</h2><p>${d.durationMs===null?'قيد التنفيذ':(d.durationMs/1000).toFixed(2)+' ثانية'} · ${d.requests} طلب</p><div class="table-scroll"><table><thead><tr><th>المحرك</th><th>الحالة</th><th>العدد</th><th>المحاولات</th><th>محسومة</th><th>غير محسومة</th></tr></thead><tbody>${d.modules.map(m=>`<tr><td>${esc(moduleNames[m.id]||m.id)}</td><td>${esc(states[m.state])}</td><td>${m.units}</td><td>${m.attempted??m.units}</td><td>${m.conclusive??m.units}</td><td>${m.inconclusive??0}</td></tr>`).join('')}</tbody></table></div>${d.reasons.map(r=>`<p class="coverage-note">${esc(r)}</p>`).join('')}`;
  }
  const running=runs.some(r=>r.status==='running');
  $('start').disabled=posting||!taskId||running;$('task').disabled=posting;$('newTask').disabled=posting;
  $('cancel').hidden=run?.status!=='running';$('markdown').disabled=!run;$('json').disabled=!run;
  $('sarif').disabled=!run;$('retest').disabled=!run||running||posting;
  $('runTitle').textContent=run?(run.target||'فحص مصدر مساحة المهمة'):'ابدأ من نطاق واضح';
  $('runTitle').dir=run?.target?'ltr':'rtl';
  $('runInfo').textContent=run?`${labels[run.status]} · ${new Date(run.createdAt).toLocaleString('ar-SA')} · ${run.id}`:'لن تظهر نتائج قبل تنفيذ فحص فعلي.';
  $('progressBox').hidden=!run;
  if(run){$('runStatus').textContent=labels[run.status];$('progressText').textContent=`${run.completed} / ${run.total}`;$('progress').max=run.total;$('progress').value=run.completed;}
  $('coverageInfo').textContent=run?`${run.evidence?.length??0} طلب HTTP / ${run.scope?.maxRequests??'—'} · ${run.discovery?.pages.length??0} صفحة مكتشفة · ${run.authenticated?'بجلسة مصادقة':'بدون جلسة'}${run.discovery?.truncated?' · بلغ الاكتشاف حد الصفحات':''}`:'';
  const findings=run?.findings||[];
  $('metrics').innerHTML=[['ملاحظات أمنية',findings.filter(f=>f.verdict==='finding').length],['عالية / حرجة',findings.filter(f=>f.verdict==='finding'&&['high','critical'].includes(f.severity)).length],['فحوص متعذرة',findings.filter(f=>f.verdict==='error').length],['مؤشرات المصدر',run?.scan?.staticRisks.length??0]].map(([name,n])=>`<div class="metric"><strong>${run?n:'—'}</strong><span>${name}</span></div>`).join('');
  $('history').innerHTML=runs.length?runs.map(r=>`<button data-run="${esc(r.id)}" aria-pressed="${run?.id===r.id}">${esc(r.target||'مصدر مساحة المهمة')}<br>${esc(labels[r.status])} · ${esc(new Date(r.createdAt).toLocaleString('ar-SA'))}</button>`).join(''):'<p class="hint">لا توجد تقييمات محفوظة بعد.</p>';
  document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tab===tab)));
  $('filter').hidden=tab!=='findings';
  const empty=text=>`<div class="empty">${text}</div>`;
  if(!run){$('results').innerHTML=empty('حدّد مساحة المهمة وعنوان النظام، ثم شغّل التقييم.');return;}
  const error=run.error?`<p role="status">${esc(run.error)}</p>`:'';
  if(tab==='authorization'){
    const proofs=run.browser?.proofs.filter(p=>p.kind==='authorization')||[],coverage=run.diagnostics?.authorizationCoverage;
    const outcomes={observed:'رُصد الوصول',not_observed:'ثبت المنع',inconclusive:'غير محسوم'};
    $('results').innerHTML=error+`<section><h2>مصفوفة الصلاحيات الفعلية</h2><p>مخطط: ${coverage?.planned??0} · محسوم: ${coverage?.conclusive??0} · غير محسوم: ${coverage?.inconclusive??0} · لم يُنفّذ: ${Math.max(0,(coverage?.planned??0)-proofs.length)}</p><p class="coverage-note">نجاح الحساب المسموح شرط لتفسير نتيجة الحساب الممنوع. تُفحص هوية الجلسة قبل الطلب وبعده؛ ظهور واجهة لا يثبت وحده حماية API.</p><div class="table-scroll"><table><thead><tr><th>الحالة</th><th>الحساب</th><th>المتوقع</th><th>النتيجة</th><th>الجلسة قبل / بعد</th></tr></thead><tbody>${proofs.map(p=>`<tr><td>${esc(p.observations.caseId)}</td><td>${esc(p.observations.account)}</td><td>${p.observations.expected==='allow'?'سماح':'منع'}</td><td>${esc(outcomes[p.outcome])}</td><td>${p.observations.sessionBefore===true?'صالحة':'غير مثبتة'} / ${p.observations.sessionAfter===true?'صالحة':'غير مثبتة'}</td></tr>`).join('')}</tbody></table></div>${proofs.map(p=>`<details><summary>${esc(p.observations.caseId)} / ${esc(p.observations.account)} — الدليل</summary><p dir="auto">${esc(p.summary)}</p><pre>${esc(JSON.stringify(p.observations,null,2))}</pre><p class="mono">${esc(p.requestIds.join(', '))}</p>${p.artifact?`<a href="${esc(endpoint('/'+run.id+'/browser-evidence/'+p.id))}" target="_blank" rel="noopener">لقطة الدليل</a>`:''}</details>`).join('')}</section>`;return;
  }
  if(tab==='browser'){
    const b=run.browser, outcomes={observed:'رُصد',not_observed:'لم يُرصد',inconclusive:'غير محسوم'}, kinds={session:'التحقق من هوية الحساب',authorization:'اختبار الصلاحيات بين الحسابات',login:'تسجيل الدخول',flow:'تدفق SPA',render:'عرض JavaScript',dom_canary:'علامة DOM XSS',framing:'التضمين داخل إطار',access:'الوصول إلى عنصر محمي'};
    $('results').innerHTML=error+(b?`<section><h2>أدلة المتصفح · ${esc(b.engine)} ${esc(b.version)}</h2><p>${b.resources?`موارد مستلمة: ${(b.resources.receivedBytes/1000000).toFixed(2)} / ${b.resources.totalLimitBytes/1000000} MB · حد المورد ${b.resources.responseLimitBytes/1000000} MB · `:''}${b.pages.length} صفحة · ${b.proofs.length} دليل · ${b.incomplete?'تغطية جزئية':'اكتملت الاختبارات المحددة'}</p><p class="coverage-note">عدم رصد العلامة لا يثبت غياب جميع ثغرات XSS. التضمين قد يكون مقصودًا؛ راجع حساسية الصفحة. لقطات الأدلة تخفي المدخلات وأسرار الجلسة المعروفة، وقد تبقى بيانات أخرى ظاهرة.</p>${b.proofs.map(p=>`<article class="finding" id="proof-${esc(p.id)}"><h3>${esc(kinds[p.kind]||p.kind)} · ${esc(outcomes[p.outcome])}</h3><p dir="ltr">${esc(p.target)}</p>${p.observations.finalUrl?`<p>الصفحة الظاهرة: <span dir="ltr">${esc(p.observations.finalUrl)}</span>${p.observations.routeChanged?" — تغيّر المسار؛ تغطية الصفحة المطلوبة غير مثبتة":""}</p>`:""}<p dir="auto">${esc(p.summary)}</p><details><summary>الشروط والأدلة</summary><pre>${esc(JSON.stringify(p.observations,null,2))}</pre><p class="mono">${esc(p.at)} · ${esc(p.requestIds.join(', '))}</p>${p.artifact?`<a href="${esc(endpoint('/'+run.id+'/browser-evidence/'+p.id))}" target="_blank" rel="noopener">فتح لقطة الدليل</a><p class="mono">SHA256: ${esc(p.artifact.sha256)}</p>`:'<p>لا توجد لقطة محفوظة لهذا الاختبار.</p>'}</details></article>`).join('')}<details><summary>طلبات محظورة (${b.blocked.length})</summary><pre>${esc(b.blocked.map(x=>x.reason+' — '+x.url).join('\n'))}</pre></details></section>`:empty(run.browserOptions?.enabled?'لم يبدأ المتصفح أو تعذر تشغيله؛ راجع سجل التنفيذ.':'فعّل المتصفح الفعلي عند إنشاء الحملة لجمع أدلة JavaScript.'));return;
  }
  if(tab==='assets'){
    const rows=run.discovery?.pages||[];
    const apiCoverage=run.diagnostics?.apiOperations;
    const apiTable=apiCoverage?`<section><h2>تغطية عمليات OpenAPI</h2><p>عدد العمليات: ${apiCoverage.length}. نجاح HTTP لا يثبت سلامة العملية أو صلاحياتها.</p><table><thead><tr><th>العملية</th><th>مسارات مولّدة</th><th>طُلبت</th><th>HTTP ناجح</th><th>سبب الاستبعاد</th></tr></thead><tbody>${apiCoverage.map(o=>`<tr><td dir="ltr">${esc(o.method+' '+o.path)}</td><td>${o.urls.length}</td><td>${o.requestedUrls.length}</td><td>${o.successfulUrls.length}</td><td>${esc(o.reason||'—')}</td></tr>`).join('')}</tbody></table></section>`:'';
    $('results').innerHTML=error+apiTable+`<section><h2>النطاق المعتمد</h2><pre>${esc((run.scope?.seeds||[]).join('\n'))}</pre><p>الاستثناءات: ${esc((run.scope?.exclusions||[]).join('، ')||'لا توجد')}</p><p class="coverage-note">${rows.length} صفحة · ${run.discovery?.skipped??0} رابط مستبعد. الاكتشاف الأساسي يقرأ HTML وOpenAPI؛ نتائج JavaScript في تبويب أدلة المتصفح. استجابات HTTP الأساسية محدودة بـ 32 KiB.</p><div class="table-scroll"><table><thead><tr><th>الأصل</th><th>الحالة</th><th>المصدر</th><th>النماذج</th></tr></thead><tbody>${rows.map(p=>`<tr><td dir="ltr">${esc(p.url)}</td><td>${p.status??'—'}</td><td>${esc(p.source)}</td><td>${p.forms??0}</td></tr>`).join('')}</tbody></table></div></section><section><h2>سجل طلبات HTTP</h2><p>لا تُحفظ ترويسات المصادقة أو أجسام الاستجابات؛ تُحفظ بصمة المحتوى المحدود وحالة الطلب.</p><div class="table-scroll"><table><thead><tr><th>الدليل</th><th>الطلب</th><th>الحالة</th><th>المدة ms</th><th>الجلسة</th></tr></thead><tbody>${(run.evidence||[]).map(e=>`<tr><td>${esc(e.id)}</td><td dir="ltr">${esc(e.method+' '+e.url)}</td><td>${e.status}</td><td>${e.durationMs}</td><td>${e.authenticated?'نعم':'لا'}</td></tr>`).join('')}</tbody></table></div></section>`;return;
  }
  if(tab==='comparison'){
    const c=run.comparison,baseline=runs.find(r=>r.id===c?.baselineId);
    $('results').innerHTML=error+(c?`<section><h2>مقارنة مع التقييم السابق</h2><p class="mono">${esc(c.baselineId)}</p><p class="coverage-note">«لم تُرصد مجددًا» تعني أن الفحص نفسه اكتمل دون إعادة رصد الملاحظة. النتائج التي لم تُفحص أو تعذر فحصها تبقى «غير متحقق منها».</p>${[['new','جديدة'],['persistent','مستمرة'],['notObserved','لم تُرصد مجددًا'],['unverified','غير متحقق منها']].map(([key,label])=>`<details open><summary>${label} (${c[key].length})</summary>${c[key].map(id=>{const finding=run.findings.find(f=>f.fingerprint===id)||baseline?.findings.find(f=>f.fingerprint===id);return `<div class="comparison-row"><strong dir="auto">${esc(finding?.title||id)}</strong><p class="mono">${esc(finding?.target||id)}</p></div>`;}).join('')}</details>`).join('')}</section>`:empty('اختر حملة مكتملة واضغط «إعادة الاختبار» لتشغيل نفس النطاق والإعدادات ومقارنة النتائج.'));return;
  }
  if(tab==='events'){$('results').innerHTML=error+'<section><h2>سجل التنفيذ الفعلي</h2><pre>'+esc(run.events.map(e=>`${e.at}  ${e.message}`).join('\n'))+'</pre></section>';return;}
  if(tab==='source'){
    const scan=run.scan;
    $('results').innerHTML=error+(scan?`<section><h2>${scan.filesScanned} ملف · ${scan.routes.length} مسار</h2><p>تحليل أنماط محدود بـ 200 ملف. النتائج مؤشرات للمراجعة وليست ثغرات مؤكدة.</p>${scan.coverage?`<section><h3>تغطية تحليل المصدر</h3><p>${scan.coverage.incomplete?"جزئية — توجد ملفات لم يكتمل تحليلها":"اكتملت الملفات المؤهلة ضمن القواعد المحددة"}</p><p>SQL: ${scan.coverage.sqlAnalyzed} ملف محلل · ${scan.coverage.sqlParseErrors} تعذر تحليله · ${scan.coverage.sqlUnsupported} بلغة غير مدعومة لهذا المحلل</p><p>تجاوز الحجم: ${scan.coverage.oversized} · تعذر القراءة: ${scan.coverage.unreadable} · حد الملفات: ${scan.coverage.limitReached?"تم بلوغه؛ العدد المتبقي غير معروف":"لم يقطع الفحص"}</p><pre>${esc(scan.coverage.warnings.map(w=>w.file+" — "+w.reason).join("\n"))}</pre><p>تُستثنى روابط الملفات ومجلدات الاعتماديات والبناء والمجلدات المخفية. عرض الأسباب محدود بأول 100 حالة. اكتمال التحليل لا يثبت خلو المصدر من الثغرات.</p></section>`:""}${scan.staticRisks.map(r=>`<article class="finding"><span class="tag ${esc(r.severity)}">${esc(r.severity)}</span><strong>${esc(r.rule)}</strong><pre>${esc(r.file)}:${r.line}\n${esc(r.snippet)}</pre></article>`).join('')||'<p>لا توجد مؤشرات ضمن الملفات المفحوصة.</p>'}<details><summary>المسارات المكتشفة (${scan.routes.length})</summary><pre>${esc(scan.routes.map(r=>`${r.method} ${r.path} — ${r.file}:${r.line}`).join('\n')||'لا توجد مسارات مكتشفة.')}</pre></details></section>`:empty('لم يُنفّذ فحص المصدر في هذا التقييم.'))+(run.inventory?`<section><h2>اعتماديات npm (${run.inventory.packages.length})</h2>${run.inventory.warnings.map(w=>`<p dir="auto">${esc(w)}</p>`).join('')}<details><summary>عرض قائمة الحزم والإصدارات</summary><pre>${esc(run.inventory.packages.map(p=>`${p.name}@${p.version}${p.dev?' (dev)':''}`).join('\n'))}</pre></details></section>`:'');return;
  }
  const shown=findings.filter(f=>$('filter').value==='all'||f.verdict===$('filter').value);
  $('results').innerHTML=error+(shown.length?shown.map(f=>`<article class="finding"><span class="tag ${esc(f.verdict==='finding'?f.severity:f.verdict)}">${esc(labels[f.verdict])} · ${esc(f.severity)}</span><h3 dir="auto">${esc(f.title)}</h3><p>${esc(names[f.check]||f.check)}</p>${f.confidence==='review'?'<p class="review-note">مؤشر يحتاج مراجعة — ليس ثغرة مؤكدة.</p>':''}<details><summary>عرض الدليل والمعالجة</summary><pre>${esc(f.detail)}</pre><p dir="auto">${esc(f.remediation||'لا توجد توصية إضافية لهذا الفحص.')}</p><p class="mono">${esc(f.target)}</p>${findingProofs(f)}<div class="evidence-list">${(f.requestIds||[]).map(id=>{const e=run.evidence?.find(e=>e.id===id);return e?`${esc(id)} · ${esc(e.method)} · HTTP ${e.status} · ${esc(e.at)}<br>SHA256: ${esc(e.bodyHash)}<br>`:esc(id);}).join('')}</div>${f.verdict==='finding'&&run.status!=='running'?triageForm(f)+repairForm(f):''}</details></article>`).join(''):empty(run.status==='running'?'جارٍ جمع الأدلة من الهدف…':'لا توجد نتائج مطابقة للعرض الحالي.'));
}
function repairForm(f){
  if(f.check!=='source_html')return '';
  const d=repairDrafts.get(run.id+':'+f.fingerprint);
  if(!d)return `<button type="button" data-repair-prepare="${esc(f.fingerprint)}">إعداد اقتراح إصلاح للعرض النصي</button>`;
  return `<section><h4>اقتراح إصلاح قابل للمراجعة</h4><p dir="ltr">${esc(d.file)}:${d.line} · innerHTML → textContent</p><p>يحوّل HTML إلى نص. قد يغيّر التنسيق المقصود. لا يثبت تطبيقه سد الثغرة؛ شغّل الاختبارات الوظيفية ثم إعادة الاختبار الأمني.</p><p class="mono">SHA256: ${esc(d.baseHash)} → ${esc(d.afterHash)}</p><p>الحالة: ${esc(d.state)}</p>${d.recovery?`<p dir="auto">${esc(d.recovery)}</p>`:""}${['draft','applied'].includes(d.state)?`<label><input type="checkbox" data-repair-review="${esc(d.id)}">راجعت التغيير وأوافق على ${d.state==='draft'?'تطبيقه':'استعادة الملف السابق'} في مساحة المهمة</label><button type="button" data-repair-change="${esc(f.fingerprint)}" data-repair-action="${d.state==='draft'?'apply':'rollback'}">${d.state==='draft'?'تطبيق الإصلاح':'التراجع عن الإصلاح'}</button>`:''}</section>`;
}
function triageForm(f){const w=f.workflow||{state:'open',owner:'',note:''};return `<form class="triage" data-finding="${esc(f.fingerprint)}"><label>حالة المعالجة<select name="state">${[['open','مفتوحة'],['reviewing','قيد المراجعة'],['accepted','مخاطرة مقبولة']].map(([id,label])=>`<option value="${id}" ${w.state===id?'selected':''}>${label}</option>`).join('')}</select></label><label>مسؤول المعالجة<input name="owner" maxlength="120" value="${esc(w.owner)}"></label><label class="wide">ملاحظات المعالجة<textarea name="note" maxlength="2000" rows="2">${esc(w.note)}</textarea></label><button type="submit">حفظ المتابعة</button><span class="hint">الإصلاح يُراجع بإعادة الاختبار.</span></form>`;}
async function refresh(token=generation){
  const url=endpoint();const data=await api(url);if(token!==generation)return;
  capabilities=data.capabilities;runs=data.runs;run=runs.find(r=>r.id===run?.id)||runs[0]||null;
  if(run&&capabilities?.revision>=10){const saved=await api(endpoint('/'+run.id+'/repairs'));if(token!==generation)return;for(const d of saved.repairs)repairDrafts.set(d.runId+':'+d.fingerprint,d);}
  $('workspace').textContent=data.workspace;
  draw();clearTimeout(timer);
  if(runs.some(r=>r.status==='running'))timer=setTimeout(()=>refresh(token).catch(e=>{if(token===generation){notice('تعذر تحديث الحالة: '+e.message);timer=setTimeout(()=>safely(()=>refresh(token))(),3000);}}),1000);
}
async function selectTask(){
  generation++;clearTimeout(timer);taskId=$('task').value;run=null;runs=[];clearCredentials();notice();remember();draw();
  if(taskId)await refresh();else $('workspace').textContent='';
}
$('task').onchange=safely(selectTask);
$('newTask').onclick=safely(async()=>{
  posting=true;draw();try{const {task}=await api('/api/tasks/draft',{mode:'build',title:'تقييم أمني'});const option=new Option(task.title,task.id);$('task').add(option);$('task').value=task.id;await selectTask();}finally{posting=false;draw();}
});
$('scope').onsubmit=safely(async event=>{
  event.preventDefault();if(posting||!taskId)return;
  const current=await api(endpoint());capabilities=current.capabilities;
  if($('browserEnabled').checked&&!(capabilities?.revision>=5))throw Error('الخادم الجاري لا يعلن دعم محرك المتصفح المحدث. أعد تشغيل الخادم ثم حدّث الصفحة؛ لم تبدأ حملة محدودة بدلًا منه.');
  if($('browserEnabled').checked&&JSON.parse($('apiGrants').value||'[]').length&&!(capabilities?.revision>=6))throw Error('API origin grants require server revision 6; update the runtime first.');
  if($('browserEnabled').checked&&JSON.parse($('authorizationCases').value||'[]').some(c=>c.api)&&!(capabilities?.revision>=7))throw Error('Cross-origin authorization requires server revision 7.');
  if(Number($('maxRequests').value)>1000&&!(capabilities?.revision>=12))throw Error('Request budgets above 1000 require security engine revision 12.');
  if(JSON.parse($('readyRoutes').value||'[]').length&&!(capabilities?.revision>=14))throw Error('Route readiness requires security engine revision 14.');
  if(openapi&&!(capabilities?.revision>=9))throw Error('OpenAPI coverage planning requires server revision 9.');
  if(($('target').value.trim()||lines('seeds').length)&&!$('authorized').checked)throw Error('أكّد تصريحك لفحص جميع الأهداف أولًا.');
  posting=true;draw();notice();const token=generation;
  try{const data=await api(endpoint(),{target:$('target').value.trim(),profile:$('profile').value,scope:{seeds:lines('seeds'),exclusions:lines('exclusions'),maxPages:Number($('maxPages').value),maxRequests:Number($('maxRequests').value),maxDepth:Number($('maxDepth').value),delayMs:Number($('delayMs').value),timeoutSeconds:Number($('timeoutSeconds').value)},auth:authentication(),browserSecrets:JSON.parse($("browserSecrets").value||"{}"),browser:browserOptions(),openapi,openapiFixtures:JSON.parse($("openapiFixtures").value||"{}"),protectedPaths:lines('protectedPaths'),authorized:$('authorized').checked,includeSource:$('source').checked,includeDependencies:$('dependencies').checked,queryAdvisories:$('advisories').checked,checks:[...document.querySelectorAll('[data-check]:checked')].map(c=>c.dataset.check)});clearCredentials();if(token!==generation)return;run=data.run;await refresh(token);}finally{posting=false;draw();}
});
$('retest').onclick=safely(async()=>{if(!run||posting)return;if(run.target&&!$('authorized').checked)throw Error('أكّد التصريح للنطاق الأصلي قبل إعادة الاختبار.');const token=generation;posting=true;draw();try{const data=await api(endpoint('/'+run.id+'/retest'),{authorized:$('authorized').checked,auth:authentication(),browserSecrets:JSON.parse($("browserSecrets").value||"{}"),queryAdvisories:$('advisories').checked});clearCredentials();if(token!==generation)return;run=data.run;tab='comparison';await refresh(token);}finally{posting=false;draw();}});
$('results').addEventListener('submit',event=>{const form=event.target.closest('[data-finding]');if(!form)return;event.preventDefault();const data=new FormData(form),id=run.id,token=generation,revision=run.revision;const button=form.querySelector('button');button.disabled=true;safely(async()=>{try{const result=await api(endpoint('/'+id+'/triage'),{fingerprint:form.dataset.finding,expectedRevision:revision,state:data.get('state'),owner:data.get('owner'),note:data.get('note')});if(token!==generation)return;if(run.id===id)run=result.run;await refresh(token);notice('حُفظت متابعة المعالجة.');}finally{button.disabled=false;}})();});
$('cancel').onclick=safely(async()=>{if(run){await api(endpoint('/'+run.id+'/cancel'),{});await refresh();}});
$('history').onclick=event=>{const b=event.target.closest('[data-run]');if(b){run=runs.find(r=>r.id===b.dataset.run);draw();}};
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;draw();});$('filter').onchange=draw;
function download(content,type,name){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('json').onclick=()=>{if(run)download(JSON.stringify(run,null,2),'application/json',`security-${run.id}.json`);};
$('markdown').onclick=safely(async()=>{if(!run)return;const id=run.id;const res=await fetch(endpoint('/'+id+'/report'));if(!res.ok)throw Error('تعذر تنزيل التقرير');download(await res.text(),'text/markdown',`security-${id}.md`);});
$('sarif').onclick=safely(async()=>{if(!run)return;const id=run.id;const res=await fetch(endpoint('/'+id+'/sarif'));if(!res.ok)throw Error('تعذر تنزيل SARIF');download(await res.text(),'application/sarif+json',`security-${id}.sarif`);});
$('openapi').onchange=safely(async()=>{const file=$('openapi').files[0];openapi=undefined;$('clearApi').hidden=true;if(!file)return;if(file.size>200000)throw Error('حجم OpenAPI الأقصى 200 KB.');const parsed=JSON.parse(await file.text());if(!parsed?.paths||typeof parsed.paths!=='object')throw Error('ملف OpenAPI لا يحتوي paths.');openapi={paths:parsed.paths};$('apiInfo').textContent=`${file.name} · ${Object.keys(parsed.paths).length} مسار؛ تُطبق حدود النطاق قبل التشغيل.`;$('clearApi').hidden=false;});
$('clearApi').onclick=()=>{openapi=undefined;$('openapiFixtures').value='';$('openapi').value='';$('apiInfo').textContent='لم يُحدد ملف OpenAPI.';$('clearApi').hidden=true;};
$('checks').innerHTML=Object.entries(names).map(([id,label])=>`<label class="check"><input type="checkbox" data-check="${id}" checked>${label}</label>`).join('');
$('target').oninput=()=>{$('authorized').checked=false;};
$('seeds').oninput=()=>{$('authorized').checked=false;};
$('advisories').onchange=()=>{if($('advisories').checked)$('dependencies').checked=true;};
$('dependencies').onchange=()=>{if(!$('dependencies').checked)$('advisories').checked=false;};
$('scope').addEventListener('input',executionPlan);
$('scope').addEventListener('change',executionPlan);
draw();
safely(async()=>{const data=await api('/api/tasks');for(const task of data.tasks)$('task').add(new Option(task.title||task.id,task.id));let saved;try{saved=localStorage.getItem('loam-security-task');}catch{}if(saved&&data.tasks.some(t=>t.id===saved)){$('task').value=saved;await selectTask();}})();

$('results').addEventListener('click',safely(async event=>{
  const prepare=event.target.closest('[data-repair-prepare]'),change=event.target.closest('[data-repair-change]');if(!prepare&&!change)return;
  const fingerprint=prepare?.dataset.repairPrepare||change.dataset.repairChange,runId=run.id,key=runId+':'+fingerprint;
  if(!(capabilities?.revision>=10))throw Error('Source repair requires server revision 10.');
  let suffix='/'+runId+'/repairs',body={fingerprint};
  if(change){const draft=repairDrafts.get(key);if(!$('results').querySelector('[data-repair-review="'+draft.id+'"]').checked)throw Error('راجع التغيير وحدد الموافقة أولًا.');suffix+='/'+draft.id+'/'+change.dataset.repairAction;body={reviewed:true};}
  const data=await api(endpoint(suffix),body);repairDrafts.set(key,data.repair);if(run?.id===runId)draw();
}));
