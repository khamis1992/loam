import {mountRecords} from './mobile-records.js';
import {DATABASE_SERVICES,PROJECT_SERVICES,ACCOUNT_SERVICES,WORKSPACE_SERVICES} from './mobile-services.js';
import {createMobileIDE} from './mobile-ide.js';
import {createWorkbenchChrome} from './mobile-workbench-chrome.js';
import {createLocalServiceManager} from './mobile-local-services.js';
import {configureMobileLocalStore} from './mobile-record-store.js';
const $=id=>document.getElementById(id);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
export function createWorkbench({context,applySource,openTools,openData,acceptSaved,hasUnsaved,onNavigate,getScreen}){
 let pane='preview',service='tables',disposeRecords,recordContext='',recordEpoch=0,chrome;
 const ide=createMobileIDE({context,applySource,acceptSaved,hasUnsaved,onLog:message=>chrome.log(message),previewCode:()=>chrome.useCode()});
 chrome=createWorkbenchChrome({context,ide,acceptSaved,hasUnsaved,showPreview:()=>show('preview'),onNavigate,getScreen});
 const localHost=el('div');localHost.id='local-services-content';$('database-description').after(localHost);
 const localServices=createLocalServiceManager({context,onChanged:()=>window.dispatchEvent(new CustomEvent('loam-local-services-changed',{detail:{taskId:context().taskId}}))});
 const projectServiceHost=el('div');projectServiceHost.id='project-service-content';$('service-actions').after(projectServiceHost);
 const projectServices=createLocalServiceManager({context});
 let localContext='';
 function dispose(){recordEpoch++;disposeRecords?.();disposeRecords=undefined;recordContext='';}
 function show(next){
  if(pane==='code'&&ide.hasDraft()&&next!=='code'&&!ide.confirmLeave())return;
  if(next!=='database'){dispose();localServices.dispose();localContext='';}pane=next;
  for(const name of ['preview','code','database']){$('pane-'+name).hidden=name!==pane;$('tab-'+name).setAttribute('aria-selected',String(name===pane));$('tab-'+name).tabIndex=name===pane?0:-1;}
  if(pane==='code')ide.render();if(pane==='database')renderDatabase();
 }
 function renderDatabase(){
  const {project,taskId}=context(),key=(taskId||'draft')+':'+JSON.stringify(project.collections||[])+':'+service;
  $('database-nav').querySelectorAll('button').forEach(b=>b.setAttribute('aria-current',b.dataset.service===service?'page':'false'));
  const entry=DATABASE_SERVICES.find(x=>x[0]===service);$('database-title').textContent=entry[1];$('database-description').textContent=entry[3];$('database-availability').textContent=entry[2];
  $('database-tables').hidden=service!=='tables';$('database-log').hidden=true;$('database-schema').hidden=!['tables','advanced'].includes(service);
  if(localContext!==key){localContext=key;localServices.mount(localHost,service);}
  if(service!=='tables'){dispose();return;}if(recordContext===key)return;dispose();recordContext=key;
  const select=$('database-collection'),old=select.value;select.replaceChildren(...(project.collections||[]).map(c=>new Option(c.title,c.id)));if([...select.options].some(o=>o.value===old))select.value=old;
  const draw=async()=>{const serial=++recordEpoch;disposeRecords?.();disposeRecords=undefined;$('database-records').replaceChildren(el('p','جارٍ قراءة بيانات التطبيق…','help'));try{if(taskId)await configureMobileLocalStore(taskId);if(serial!==recordEpoch||pane!=='database'||service!=='tables'||context().taskId!==taskId)return;$('database-records').replaceChildren();if(select.value){$('database-records').className='record-workspace';disposeRecords=mountRecords($('database-records'),project,select.value,'loam-mobile-'+(taskId||'draft'));}else $('database-records').append(el('p','لا توجد مجموعات بيانات في هذا التطبيق. أضف مجموعة من «تعديل بنية البيانات» أو اطلبها في المحادثة.','help'));}catch(error){if(serial===recordEpoch)$('database-records').replaceChildren(el('p',error.message,'help'));}};select.onchange=()=>void draw();void draw();
 }
 for(const [id,title] of [['preview','المعاينة'],['code','الشيفرة'],['database','قاعدة البيانات']]){$('tab-'+id).onclick=()=>show(id);}
 const tabs=[...document.querySelectorAll('[data-workbench-tab]')];tabs.forEach((tab,index)=>tab.addEventListener('keydown',e=>{if(['ArrowRight','ArrowLeft','Home','End'].includes(e.key)){e.preventDefault();const forward=document.dir==='rtl'?'ArrowLeft':'ArrowRight',next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key===forward?1:-1)+tabs.length)%tabs.length;tabs[next].click();tabs[next].focus();}}));
 for(const entry of DATABASE_SERVICES){const b=el('button',entry[1]);b.dataset.service=entry[0];b.onclick=()=>{service=entry[0];renderDatabase();};$('database-nav').append(b);}
 $('database-schema').onclick=openData;
 const routes={skills:'skills',library:'skills','global-knowledge':'brain',applications:'integrations',connectors:'integrations',account:'services',usage:'services'};
 const groups=[['إعدادات المشروع',PROJECT_SERVICES],['الحساب',ACCOUNT_SERVICES],['مساحة العمل',WORKSPACE_SERVICES]];
 function selectService(entry){projectServices.dispose();projectServiceHost.replaceChildren();projectServiceHost.hidden=!['knowledge','analytics'].includes(entry[0]);if(!projectServiceHost.hidden)projectServices.mount(projectServiceHost,entry[0]);$('service-title').textContent=entry[1];$('service-availability').textContent=entry[2];$('service-description').textContent=entry[3];const actions=$('service-actions');actions.replaceChildren();const add=(label,fn)=>{const b=el('button',label);b.onclick=fn;actions.append(b);};
  if(entry[0]==='general')add('افتح أدوات المشروع',()=>{$('services-dialog').close();openTools();});
  if(entry[0]==='hosting')add('إدارة النشر المحلي',()=>{$('services-dialog').close();chrome.openPublish();});
  if(entry[0]==='cloud')add('إدارة الخدمات المحلية',()=>{$('services-dialog').close();show('database');});
  if(entry[0]==='backups'){add('نسخة JSON',()=>$('backup').click());add('سجل الإصدارات',()=>{$('services-dialog').close();chrome.openHistory();});}
  if(entry[0]==='addons')add('تحسين التصميم والمحتوى',()=>{$('services-dialog').close();$('polish').click();});
  if(routes[entry[0]]){const a=el('a','افتح خدمة Loam');a.href=routes[entry[0]]==='services'?'/#/services':routes[entry[0]]==='integrations'?'/integrations.html':'/#/services/'+routes[entry[0]];a.target='_blank';a.rel='noopener';actions.append(a);}
  $('service-nav').querySelectorAll('button').forEach(b=>b.setAttribute('aria-current',b.dataset.service===entry[0]?'page':'false'));
 }
 for(const [title,entries]of groups){const group=el('section');group.append(el('h3',title));for(const entry of entries){const button=el('button',entry[1]);button.dataset.service=entry[0];button.onclick=()=>selectService(entry);group.append(button);}$('service-nav').append(group);}
 $('open-services').onclick=()=>{selectService(PROJECT_SERVICES[0]);$('services-dialog').showModal();};$('close-services').onclick=()=>$('services-dialog').close();
 window.addEventListener('loam-local-session-changed',event=>{if(event.detail?.taskId!==context().taskId||pane!=='database')return;dispose();localContext='';renderDatabase();});
 window.addEventListener('loam-local-services-changed',event=>{if(event.detail?.taskId!==context().taskId||pane!=='database'||service!=='tables')return;dispose();localContext='';renderDatabase();});
 return {render(){chrome.render();if(pane==='code')ide.render();if(pane==='database')renderDatabase();},hasDraft:()=>ide.hasDraft()||projectServices.hasDraft(),confirmLeave:()=>ide.confirmLeave()&&projectServices.confirmLeave(),reset(){dispose();localServices.reset();projectServices.reset();projectServiceHost.replaceChildren();projectServiceHost.hidden=true;localContext='';ide.reset();chrome.reset();show('preview');},show};
}
