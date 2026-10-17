// Only trusted, bundled studio pages may request navigation or prepare a task.
export const studios = [
  {id:'mobile',mode:'build',icon:'📱',color:'emerald',tag:'LOAM MOBILE',title:'استديو تطبيقات الجوال',description:'شاشات التطبيق ومحاكي التصميم وتدفق المستخدم ومراجعة المتجر.',foot:'Screens · iOS / Android · Flow'},
  {id:'office',mode:'write',icon:'📊',color:'amber',tag:'LOAM OFFICE',title:'استديو الأوفيس وغرفة القيادة',description:'مساحة المستندات والجداول والعروض، مع غرفة القيادة ومصادر المشروع.',foot:'Word · Excel · PowerPoint · C-Suite'},
  {id:'swarm',mode:'research',icon:'🐝',color:'violet',tag:'LOAM TEAMS',title:'ذكاء الأسراب وشركة البرمجيات',description:'شبكة الفريق والمهام ومحاكاة الجمهور ومخرجات الشركة الافتراضية.',foot:'Agents · Simulation · Deliverables'},
  {id:'creative',mode:'media',icon:'🧊',color:'rose',tag:'LOAM CREATIVE',title:'استديو المجسّمات 3D والإنتاج الإبداعي',description:'المشهد والخامات والأصول وتسلسل الإعلان وإعدادات الإخراج.',foot:'Scene · Materials · Timeline · Assets'},
  {id:'security',mode:'build',icon:'🛡',color:'red',tag:'LOAM SECURITY',title:'الأمن السيبراني واختبار الاختراق الذاتي',description:'نطاق الفحص والنتائج والأدلة وخطة المعالجة وسجل المراجعة.',foot:'Scope · Findings · Remediation'}
];
export function studioById(id){return studios.find(s=>s.id===id);}
export function installStudioBridge({frame,prepare,navigate}){
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin || event.source!==frame.contentWindow)return;
    const message=event.data;
    if(!message || typeof message!=='object' || !studioById(message.studio))return;
    const active=location.hash.match(/^#\/studios\/([^/]+)$/)?.[1];
    if(!studioById(active))return;
    if(message.type==='loam:studio:navigate'){navigate(message.studio);return;}
    if(message.type==='loam:studio:prepare' && message.studio===active && typeof message.prompt==='string' && message.prompt.trim() && message.prompt.length<=16000){prepare(studioById(active),message.prompt.trim());}
  });
}
