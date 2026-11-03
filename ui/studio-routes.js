// Only trusted, bundled studio pages may request navigation or prepare a task.
export const studios = [
  {id:'mobile',mode:'build',icon:'mobile',color:'emerald',tag:'LOAM MOBILE',title:'استديو تطبيقات الجوال',description:'ابنِ شاشات مترابطة مع مساعد فعلي، واحفظ مشروعك وجرّبه وصدّر مصدر الويب وExpo.',foot:'Build · Preview · React Native · Export'},
  {id:'office',mode:'write',icon:'office',color:'amber',tag:'LOAM OFFICE',title:'استديو الأوفيس وغرفة القيادة',description:'مساحة المستندات والجداول والعروض، مع غرفة القيادة ومصادر المشروع.',foot:'Word · Excel · PowerPoint · C-Suite'},
  {id:'swarm',mode:'build',icon:'swarm',color:'violet',tag:'LOAM TEAMS',title:'ذكاء الأسراب وشركة البرمجيات',description:'فريق وكلاء يحوّل موجزك إلى متطلبات وبنية وبرمجيات، مع مراجعة كود وتحقق فعلي وإصلاح ذاتي محدود وتسليم ملفات حقيقية.',foot:'Plan · Build · Review · Repair · Deliver'},
  {id:'realswarm',mode:'build',icon:'realswarm',color:'cyan',tag:'LOAM SELF-ORGANIZING TEAM',title:'فريق عمل ذاتي (نتريو)',description:'عمال متساوون بلا مخطط مركزي: كل عامل يختار مهمته على لوحة مشتركة، يتحقق بأدلة حقيقية، ويدمج عمله عبر git — وكل رقم في اللوحة مقيس من الواقع.',foot:'Claim · Act · Verify · Merge'},
  {id:'creative',mode:'media',icon:'creative',color:'rose',tag:'LOAM CREATIVE',title:'استديو المجسّمات 3D والإنتاج الإبداعي',description:'المشهد والخامات والأصول وتسلسل الإعلان وإعدادات الإخراج.',foot:'Scene · Materials · Timeline · Assets'},
  {id:'security',mode:'build',icon:'security',color:'red',tag:'LOAM SECURITY',title:'الأمن السيبراني واختبار الاختراق الذاتي',description:'نطاق الفحص والنتائج والأدلة وخطة المعالجة وسجل المراجعة.',foot:'Scope · Findings · الإصلاح المؤمَّن'}
];
export function studioById(id){return studios.find(s=>s.id===id);}
export function installStudioBridge({frame,prepare,navigate}){
  const mobileLayout=()=>document.body.classList.toggle('mobile-studio-workspace',location.hash==='#/studios/mobile');mobileLayout();window.addEventListener('hashchange',mobileLayout);
  let expanded=false;const inerted=[];
  const setPreview=value=>{expanded=value;frame.classList.toggle('mobile-preview-expanded',value);if(value){let node=frame;while(node.parentElement){for(const sibling of node.parentElement.children)if(sibling!==node&&!sibling.inert){sibling.inert=true;inerted.push(sibling);}if(node.parentElement===document.body)break;node=node.parentElement;}}else{for(const node of inerted.splice(0))node.inert=false;}};
  window.addEventListener('hashchange',()=>setPreview(false));frame.addEventListener('load',()=>setPreview(false));
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&expanded){setPreview(false);frame.contentWindow.postMessage({type:'mobile-preview-exit'},location.origin);}});
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin || event.source!==frame.contentWindow)return;
    const message=event.data;
    if(!message || typeof message!=='object' || !studioById(message.studio))return;
    const active=location.hash.match(/^#\/studios\/([^/]+)$/)?.[1];
    if(!studioById(active))return;
    if(message.type==='loam:mobile:location'&&active==='mobile'&&message.studio==='mobile'){
      if(message.taskId!==null&&(typeof message.taskId!=='string'||!/^task_[a-zA-Z0-9_-]{1,100}$/.test(message.taskId)))return;
      if(typeof message.screenId!=='string'||! /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(message.screenId))return;
      const url=new URL(location.href);if(message.taskId){url.searchParams.set('mobileTask',message.taskId);url.searchParams.set('mobileScreen',message.screenId);}else{url.searchParams.delete('mobileTask');url.searchParams.delete('mobileScreen');}history.replaceState(history.state,'',url);return;
    }
    if(message.type==='loam:mobile:preview'&&active==='mobile'&&message.studio==='mobile'&&typeof message.expanded==='boolean'){setPreview(message.expanded);return;}
    if(message.type==='loam:studio:navigate'){navigate(message.studio);return;}
    if(message.type==='loam:studio:prepare' && message.studio===active && typeof message.prompt==='string' && message.prompt.trim() && message.prompt.length<=16000){prepare(studioById(active),message.prompt.trim());}
  });
}
