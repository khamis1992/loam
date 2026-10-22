import type { Assessment } from './assessments.js';

export const SECURITY_CAPABILITIES={revision:63,engine:'scoped-assessment',features:['html-insertion-repair','anonymous-api-collections','http','browser','login','spa-flows','scoped-post','retest','coverage-diagnostics','multi-account-authorization','identity-witness','explicit-api-origins','cross-origin-authorization','browser-resource-budgets','openapi-fixtures-coverage','reviewed-source-repairs','repair-recovery','extended-request-budget','final-route-evidence','route-readiness','source-sql-review','source-coverage','sarif-source-locations','post-authorization','json-authorization-witness','local-sql-bindings','source-nosql-review','business-replay-idempotency','business-quota-limits','business-step-order','business-pricing-credits','business-cancel-refund','business-race-concurrency','business-layer-consistency','xss-reflected','csrf-cross-origin','xss-stored','sql-nosql-injection','path-traversal','ssrf-callback','file-upload-controls','template-injection','xxe-entity','deserialization-rce','command-injection','open-redirect','source-flow-cross-file','source-flow-sanitizers','source-flow-guards','static-dynamic-linking','independent-benchmark','self-planning-surface-plan']};
export function executionDiagnostics(run:Assessment){
  const b=run.browserOptions,proofs=run.browser?.proofs??[],businessProofs=run.business?.proofs??[],injectionProofs=run.injection?.proofs??[],traversalProofs=run.traversal?.proofs??[],ssrfProofs=run.ssrf?.proofs??[],uploadProofs=run.upload?.proofs??[],templateProofs=run.template?.proofs??[],xxeProofs=run.xxe?.proofs??[],deserProofs=run.deser?.proofs??[],commandProofs=run.command?.proofs??[],redirectProofs=run.redirect?.proofs??[],finished=run.status!=='running';
  const modules=[
    {id:'anonymous_api',enabled:!!b?.enabled&&!!b?.anonymousApi?.length,units:proofs.filter(p=>p.kind==='anonymous_api').length},
    {id:'http',enabled:!!run.target,units:run.evidence.filter(e=>e.engine!=='browser').length},
    {id:'browser',enabled:!!b?.enabled,units:run.browser?.pages.length??0},
    {id:'login',enabled:!!b?.enabled&&!!(b?.login?.length||b?.accounts?.length),units:proofs.filter(p=>p.kind==='login'&&p.outcome==='observed').length},
    {id:'flows',enabled:!!b?.enabled&&!!b?.flows?.length,units:proofs.filter(p=>p.kind==='flow'&&p.outcome==='observed').length},
    {id:'post',enabled:!!b?.enabled&&!!(b?.postPaths?.length||b?.apiGrants?.some(g=>g.methods.includes('POST'))),units:run.evidence.filter(e=>e.method==='POST').length},
    {id:'api_origins',enabled:!!b?.enabled&&!!b?.apiGrants?.length,units:run.evidence.filter(e=>e.apiOrigin&&e.status>=200&&e.status<300&&!e.error&&e.method!=='OPTIONS').length},
    {id:'sessions',enabled:!!b?.enabled&&!!b?.accounts?.length,units:proofs.filter(p=>p.kind==='session'&&p.outcome==='observed').length},
    {id:'authorization',enabled:!!b?.enabled&&!!b?.authorization?.length,units:proofs.filter(p=>p.kind==='authorization'&&p.outcome!=='inconclusive').length},
    {id:'business',enabled:!!(run.businessCases?.length||run.businessQuotas?.length||run.businessSteps?.length||run.businessPricing?.length||run.businessCancels?.length||run.businessRaces?.length||run.businessConsistency?.length),units:businessProofs.filter(p=>p.outcome!=='inconclusive').length},
    {id:'xss_reflected',enabled:!!b?.enabled&&!!b?.xssReflected?.length,units:proofs.filter(p=>p.kind==='xss_reflected'&&p.outcome!=='inconclusive').length},
    {id:'csrf',enabled:!!b?.enabled&&!!b?.csrf?.length,units:proofs.filter(p=>p.kind==='csrf'&&p.outcome!=='inconclusive').length},
    {id:'xss_stored',enabled:!!b?.enabled&&!!b?.xssStored?.length,units:proofs.filter(p=>p.kind==='xss_stored'&&p.outcome!=='inconclusive').length},
    {id:'injection',enabled:!!run.injectionCases?.length,units:injectionProofs.filter(p=>p.outcome!=='inconclusive').length},
    {id:'traversal',enabled:!!run.traversalCases?.length,units:traversalProofs.filter(p=>p.outcome!=='inconclusive').length},
    {id:'ssrf',enabled:!!run.ssrfCases?.length,units:ssrfProofs.filter(p=>p.outcome!=='inconclusive').length},
    {id:'upload',enabled:!!run.uploadCases?.length,units:uploadProofs.filter(p=>p.outcome!=='inconclusive').length},
    {id:'template',enabled:!!run.templateCases?.length,units:templateProofs.filter(p=>p.outcome!=='inconclusive').length},
    {id:'xxe',enabled:!!run.xxeCases?.length,units:xxeProofs.filter(p=>p.outcome!=='inconclusive').length},
    {id:'deser',enabled:!!run.deserCases?.length,units:deserProofs.filter(p=>p.outcome!=='inconclusive').length},
    {id:'command',enabled:!!run.commandCases?.length,units:commandProofs.filter(p=>p.outcome!=='inconclusive').length},
    {id:'redirect',enabled:!!run.redirectCases?.length,units:redirectProofs.filter(p=>p.outcome!=='inconclusive').length},
    {id:'source',enabled:!!run.includeSource,units:run.scan?.filesScanned??0},
    {id:'dependencies',enabled:!!run.includeDependencies,units:run.inventory?.packages.length??0},
  ].map(m=>{
    const kind=({browser:'render',login:'login',flows:'flow',sessions:'session',authorization:'authorization',anonymous_api:'anonymous_api',business:'business_replay',xss_reflected:'xss_reflected',csrf:'csrf',xss_stored:'xss_stored',injection:'injection',traversal:'traversal',ssrf:'ssrf',upload:'upload',template:'template',xxe:'xxe',deser:'deser',command:'command',redirect:'redirect'} as const)[m.id as 'browser'|'login'|'flows'|'sessions'|'authorization'|'anonymous_api'|'business'|'xss_reflected'|'csrf'|'xss_stored'|'injection'|'traversal'|'ssrf'|'upload'|'template'|'xxe'|'deser'|'command'|'redirect'];
    const attempts=kind?[...proofs,...businessProofs,...injectionProofs,...traversalProofs,...ssrfProofs,...uploadProofs,...templateProofs,...xxeProofs,...deserProofs,...commandProofs,...redirectProofs].filter(p=>kind==='business_replay'?String(p.kind).startsWith('business_'):p.kind===kind):[];
    const attempted=kind?attempts.length:m.units;
    const inconclusive=attempts.filter(p=>p.outcome==='inconclusive').length;
    const conclusive=kind?attempted-inconclusive:m.units;
    const planned=m.id==='anonymous_api'?(b?.anonymousApi?.length??0):m.id==='flows'?(b?.flows.length??0):m.id==='login'?(b?.accounts.length|| (b?.login.length?1:0)):m.id==='sessions'?(b?.accounts.length??0):m.id==='authorization'?(b?.authorization.reduce((n,c)=>n+c.allowed.length+c.denied.length,0)??0):m.id==='business'?((run.businessCases?.length??0)+(run.businessQuotas?.length??0)+(run.businessSteps?.length??0)+(run.businessPricing?.length??0)+(run.businessCancels?.length??0)+(run.businessRaces?.length??0)+(run.businessConsistency?.length??0)):m.id==='xss_reflected'?(b?.xssReflected?.length??0):m.id==='csrf'?(b?.csrf?.length??0):m.id==='xss_stored'?(b?.xssStored?.length??0):m.id==='injection'?(run.injectionCases?.length??0):m.id==='traversal'?(run.traversalCases?.length??0):m.id==='ssrf'?(run.ssrfCases?.length??0):m.id==='upload'?(run.uploadCases?.length??0):m.id==='template'?(run.templateCases?.length??0):m.id==='xxe'?(run.xxeCases?.length??0):m.id==='deser'?(run.deserCases?.length??0):m.id==='command'?(run.commandCases?.length??0):m.id==='redirect'?(run.redirectCases?.length??0):undefined;
    const dependencyIncomplete=m.id==='dependencies'&&(run.inventory?.coverage?.complete===false||run.inventory?.advisories?.complete===false);
    const incomplete=dependencyIncomplete||(m.id==='source'&&run.scan?.coverage?.incomplete)||inconclusive>0||(m.id==='browser'&&run.browser?.incomplete)||(finished&&planned!==undefined&&attempted>0&&conclusive<planned);
    return {...m,attempted,conclusive,inconclusive,planned,state:!m.enabled?'disabled':incomplete?'incomplete':m.units?'executed':finished?'no_execution':'pending'};
  });
  const reasons:string[]=[];
  if(run.inventory?.coverage?.complete===false)reasons.push('جرد الاعتماديات غير مكتمل؛ راجع حدود الإدخالات وملف القفل قبل الاعتماد على نتائج الثغرات المعروفة.');
  if(run.inventory?.advisories?.complete===false)reasons.push('مطابقة OSV غير مكتملة؛ غياب نتيجة لا يثبت خلو الاعتماديات من الثغرات المعروفة.');
  if(run.discovery?.truncated){const l=run.discovery.limits;reasons.push(l?`روابط داخل النطاق لم تُزر: ${l.depth} بسبب العمق، ${l.pages} بسبب عدد الصفحات، ${l.queue} بسبب سعة قائمة الانتظار. راجع الأصول والتغطية.`:'توقف الاكتشاف عند حدوده؛ لا تُعد الصفحات المكتشفة تغطية كاملة للتطبيق.');}
  const changedRoutes=proofs.filter(p=>p.kind==='render'&&p.observations.routeChanged===true);
  if(changedRoutes.length)reasons.push('انتهت '+changedRoutes.length+' محاولة عرض إلى مسار مختلف؛ راجع الصفحة الظاهرة في الأدلة. تحميل صفحة الدخول لا يثبت تغطية الصفحة المحمية.');
  if(finished&&run.evidence.length>=run.scope.maxRequests)reasons.push('بلغ التنفيذ حد ميزانية الطلبات؛ راجع التغطية قبل اعتبار الفحص مكتملًا. ارفع الحد صراحةً أو قسّم الحملة، مع مراجعة المدة وميزانية الموارد.');
  if(run.target&&!b?.enabled)reasons.push('المتصفح معطّل: لم تُنفّذ JavaScript أو اختبارات الدخول وتدفقات SPA.');
  if(finished&&run.includeSource&&!run.scan?.filesScanned)reasons.push('فحص المصدر مختار، لكن مساحة المهمة لا تحتوي ملفات مصدر قابلة للفحص.');
  if(finished&&run.includeDependencies&&!run.inventory?.packages.length)reasons.push('فحص الاعتماديات مختار، لكن لم تُكتشف حزم مقفلة؛ لا توجد مطابقة OSV فعلية للحزم.');
  if(run.target&&run.discovery?.pages.length===1&&!b?.enabled)reasons.push('الاكتشاف اقتصر على صفحة واحدة؛ صفحة SPA قد لا تعرض روابط في HTML الأولي.');
  if(b?.enabled&&!run.browser?.version&&finished)reasons.push('المتصفح مختار لكن لا يوجد دليل على تشغيله؛ راجع أخطاء التنفيذ.');
  if(run.browser?.discovery?.incomplete){const d=run.browser.discovery;reasons.push(`اكتشاف روابط JavaScript جزئي: العمق ${d.limits.depth}، الصفحات ${d.limits.pages}، سعة الانتظار ${d.limits.queue}، توقف التنفيذ ${d.limits.interrupted}، صفحات تجاوزت حد جمع الروابط ${d.linkLimitedPages}. راجع الأصول والتغطية.`);}
  if(run.browser?.incomplete)reasons.push('تغطية المتصفح غير مكتملة؛ عدد الطلبات المحظورة: '+run.browser.blocked.length+'، وعدد الأدلة غير المحسومة: '+proofs.filter(p=>p.outcome==='inconclusive').length+'.');
  if(run.business?.incomplete)reasons.push('اختبارات منطق الأعمال غير محسومة: '+businessProofs.filter(p=>p.outcome==='inconclusive').length+' حالة بلا نتيجة قابلة للاعتماد؛ راجع شاهد الحالة والضابط الإيجابي قبل الاستدلال على idempotency.');
  if(b?.enabled&&!b.readySelector&&!b.readyRoutes?.length)reasons.push('لم يُحدد عنصر جاهزية للتطبيق: تحميل الصفحة والشبكة وحده لا يثبت اكتمال تدفق SPA.');
  const seeds=run.scope.seeds.map(s=>new URL(s));
  const apiOperations=run.openapiPlan?.operations.map(o=>({...o,requestedUrls:o.urls.filter(url=>run.evidence.some(e=>e.url===url&&e.method==='GET')),successfulUrls:o.urls.filter(url=>run.evidence.some(e=>e.url===url&&e.method==='GET'&&e.status>=200&&e.status<300&&!e.error))}));
  if(apiOperations?.some(o=>o.reason||o.requestedUrls.length<o.urls.length))reasons.push('تغطية OpenAPI محدودة: توجد عمليات مستبعدة أو مسارات لم تُطلب؛ راجع جدول الأصول والتغطية.');
  if(seeds.some(s=>s.pathname!=='/'&&!seeds.some(root=>root.origin===s.origin&&root.pathname==='/')))reasons.push('النطاق مقيد بمسارات محددة؛ ملفات JavaScript وواجهات API خارجها لن تُفحص دون إضافتها للنطاق.');
  return {durationMs:run.finishedAt?Math.max(0,Date.parse(run.finishedAt)-Date.parse(run.createdAt)):null,requests:run.evidence.length,modules,reasons,apiOperations,authorizationCoverage:{planned:b?.authorization?.reduce((n,c)=>n+c.allowed.length+c.denied.length,0)??0,conclusive:proofs.filter(p=>p.kind==='authorization'&&p.outcome!=='inconclusive').length,inconclusive:proofs.filter(p=>p.kind==='authorization'&&p.outcome==='inconclusive').length}};
}
