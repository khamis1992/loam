// Bundled design workspace: UI previews stay illustrative; real requests go to Loam.
const integrated = window.parent !== window;
const executionNames={mobile:'بناء التطبيقات',office:'كتابة المستندات',security:'البناء والمراجعة التقنية',creative:'التصميم الإبداعي',swarm:'البحث والتحليل'};
const savedPrompts={};
function sendStudio(type,extra={}){if(integrated)window.parent.postMessage({type,studio:current,...extra},location.origin);}
const originalRender=render;
render=function(){
  originalRender();
  document.body.classList.add('integrated-studio');
  document.querySelector('.demo').textContent='معاينة تصميمية · بيانات مثال';
  document.querySelector('.heading .badge').textContent='بيانات مثال';
  document.querySelector('.assistant-head strong').textContent='مساعد المساحة';
  document.querySelector('.version small').textContent='مثال تصميمي · ليس نتيجة تنفيذ';
  document.querySelector('.footer span').textContent='المعاينات أمثلة تصميمية؛ الطلبات الفعلية تُنفّذ في مهمة مستقلة.';
  const request=$('chat').querySelector('.request');
  request.insertAdjacentHTML('afterbegin','<small class="example-label">مثال لطلب في هذه المساحة</small>');
  const submit=document.querySelector('.send');submit.setAttribute('aria-label','تحضير الطلب للتنفيذ');submit.title='تحضير الطلب للتنفيذ';
  $('prompt').value=savedPrompts[current]||'';
  $('prompt').placeholder='اكتب طلبك الفعلي لهذه المساحة…';
  $('prompt').oninput=()=>savedPrompts[current]=$('prompt').value;
  $('composer').onsubmit=event=>{event.preventDefault();if(!$('prompt').value.trim())return;if(!integrated){toast('افتح هذه المساحة من تطبيق Loam لبدء مهمة.');return;}sendStudio('loam:studio:prepare',{prompt:$('prompt').value});};
  const note=document.createElement('p');note.className='execution-note';note.textContent='التنفيذ المتاح: '+executionNames[current]+' · راجع الطلب قبل البدء.';$('composer').prepend(note);
  const start=document.createElement('button');start.className='primary';start.id='studioPrepare';start.textContent='ابدأ مهمة فعلية';start.onclick=()=>{$('prompt').focus();if(!$('prompt').value.trim())toast('اكتب الطلب في مساعد المساحة، ثم اضغط سهم المتابعة.');else $('composer').requestSubmit();};document.querySelector('.heading .actions').prepend(start);
  document.querySelector('[data-action=attach]').onclick=()=>{if(!$('prompt').value.trim()){toast('اكتب وصف المهمة أولًا، ثم تابع لإرفاق الملفات في مساحة المهمة.');$('prompt').focus();return;}$('composer').requestSubmit();};
};
// Parent owns the route so reload, Back/Forward and sidebar links stay consistent.
$('nav').addEventListener('click',event=>{const link=event.target.closest('a');if(!link || !integrated)return;event.preventDefault();const target=link.hash.slice(1);if(Object.hasOwn(modes,target))sendStudio('loam:studio:navigate',{studio:target});});
render();
