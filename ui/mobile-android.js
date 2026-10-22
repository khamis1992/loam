export function createAndroidPanel({api,context,prepare,run}){
 const $=id=>document.getElementById(id),dialog=$('android-dialog');
 let task=null,env=null,job=null,pending=false,timer=null,sequence=0;
 const labels={building:'جارٍ إنشاء ملف Android…',succeeded:'ملف Android جاهز',failed:'لم يكتمل البناء',cancelled:'أُوقف البناء',interrupted:'انقطعت متابعة البناء',unobserved:'عملية سابقة قيد التحقق'};
 function render(){
  $('android-status').textContent=pending?'جارٍ تنفيذ الطلب…':job?labels[job.status]:'ابنِ نسخة تعمل على جهاز Android';
  $('android-start').disabled=pending||!env?.ready||['building','unobserved'].includes(job?.status);
  $('android-cancel').hidden=job?.status!=='building';$('android-cancel').disabled=pending;
  $('android-project').textContent=task?task.title+' · الإصدار '+task.revision:'';
  $('android-version').textContent=job?'البناء من الإصدار '+job.revision+(job.revision!==task?.revision?' · توجد نسخة أحدث في الاستوديو':''):'';
  $('android-error').textContent=job?.error||'';
  $('android-download').hidden=job?.status!=='succeeded';$('android-source').hidden=!job;
  for(const [id,kind]of [['android-download','apk'],['android-source','source']])if(job)$(id).href='/api/mobile/android/artifact?'+new URLSearchParams({taskId:task.taskId,buildId:job.id,kind});
  $('android-fingerprint').textContent=job?.apk?'APK · '+(job.apk.bytes/1048576).toFixed(1)+' MB · SHA256 '+job.apk.sha256:'';
 }
 async function refresh(token){
  if(token!==sequence||!dialog.open)return;
  try{const data=await api('/api/mobile/android?'+new URLSearchParams({taskId:task.taskId}));if(token!==sequence)return;job=data.build;$('android-log').textContent=data.log||'سيظهر سجل المترجم هنا.';$('android-error').textContent='';render();}
  catch(e){if(token===sequence)$('android-error').textContent=e.message;}
  if(token===sequence&&dialog.open)timer=setTimeout(()=>void refresh(token),job?.status==='building'?1500:5000);
 }
 $('android-open').onclick=()=>run(async()=>{
  task=context();job=null;env=null;$('android-log').textContent='';$('android-checks').textContent='جارٍ فحص بيئة Android…';render();dialog.showModal();const token=++sequence;
  try{env=await api('/api/mobile/android/environment');$('android-checks').replaceChildren(...env.checks.map(c=>{const n=document.createElement('li');n.textContent=(c.ready?'جاهز · ':'مطلوب · ')+c.label;return n;}));render();if(task.taskId)await refresh(token);}
  catch(e){$('android-error').textContent=e.message;}
 });
 $('android-start').onclick=()=>run(async()=>{pending=true;render();clearTimeout(timer);++sequence;let error='';try{task=await prepare();const data=await api('/api/mobile/android/build',{taskId:task.taskId,expectedRevision:task.revision});job=data.build;}catch(e){error=e.message;}finally{pending=false;render();}if(error){$('android-error').textContent=error;return;}void refresh(sequence);});
 $('android-cancel').onclick=async()=>{pending=true;render();try{await api('/api/mobile/android/cancel',{taskId:task.taskId,buildId:job.id});}catch(e){$('android-error').textContent=e.message;}finally{pending=false;$('android-cancel').disabled=false;}};
 $('android-close').onclick=()=>dialog.close();
 dialog.addEventListener('close',()=>{clearTimeout(timer);++sequence;});
 return {render};
}
