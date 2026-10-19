const $=id=>document.getElementById(id);
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
export async function mobileRequest(path,taskId,body){const response=await fetch('/api/mobile/'+path+(body?'':'?taskId='+encodeURIComponent(taskId)),body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId,...body})}:{});const data=await response.json();if(!response.ok)throw Error(data.error||'HTTP '+response.status);return data;}
export function createMobileIDE({context,applySource,acceptSaved,hasUnsaved,onLog,previewCode}){
 let task='',revision=-1,tag='',files={},active='mobile.json',opened=['mobile.json'],loading,epoch=0,busy=false,paintFrame=0;const drafts=new Map();
 const pane=$('pane-code'),editor=$('source-editor');
 pane.querySelector('.pane-heading h2').id='source-path';pane.querySelector('.pane-heading .help').textContent='احفظ الملف؛ تظهر تغييرات الويب في المعاينة مباشرة. ملفات Expo وAndroid أهداف تصدير أصلية.';
 const shell=node('div',undefined,'code-shell'),explorer=node('nav',undefined,'code-explorer');explorer.setAttribute('aria-label','ملفات التطبيق');
 const head=node('div',undefined,'code-file-tools'),search=node('input');search.type='search';search.id='file-search';search.placeholder='ابحث عن ملف';search.setAttribute('aria-label','البحث في الملفات');
 const add=node('button','+');add.title='ملف ويب جديد';add.id='file-new';head.append(search,add);
 const tree=node('div');tree.id='file-tree';explorer.append(head,tree);const content=node('div',undefined,'code-content'),tabs=node('nav',undefined,'code-file-tabs');tabs.id='file-tabs';tabs.setAttribute('aria-label','الملفات المفتوحة');
 const area=node('div',undefined,'code-area'),numbers=node('pre',undefined,'code-lines'),paint=node('pre',undefined,'code-paint');numbers.setAttribute('aria-hidden','true');paint.setAttribute('aria-hidden','true');
 editor.wrap='off';editor.autocapitalize='off';editor.setAttribute('aria-label','محرر شيفرة التطبيق');area.append(numbers,paint,editor);content.append(tabs,area);shell.append(explorer,content);pane.querySelector('.pane-heading').after(shell);
 const actions=pane.querySelector('.actions'),preview=node('button','معاينة الشيفرة'),regenerate=node('button','إعادة توليد الملف'),importFile=node('button','استيراد تعديل الطرفية'),more=node('details',undefined,'code-actions-more');more.append(node('summary','⋯'));const menu=node('div');menu.append(regenerate,importFile);more.append(menu);preview.id='code-run';regenerate.id='file-regenerate';importFile.id='file-import';actions.append(preview,more);$('source-reset').textContent='إلغاء المسودة';
 function highlight(){
  const value=editor.value,fragment=document.createDocumentFragment();const re=/(\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:import|from|export|default|const|let|var|function|return|async|await|if|else|class|new|true|false|null|throw|try|catch|for|of|while)\b|\b\d+(?:\.\d+)?\b)/g;
  let last=0;for(const match of value.slice(0,180000).matchAll(re)){fragment.append(document.createTextNode(value.slice(last,match.index)));const token=node('span',match[0],/^\/\//.test(match[0])||match[0].startsWith('/*')?'token-comment':/^["'`]/.test(match[0])?'token-string':/^\d/.test(match[0])?'token-number':'token-keyword');fragment.append(token);last=match.index+match[0].length;}fragment.append(document.createTextNode(value.slice(last)+'\n'));paint.replaceChildren(fragment);numbers.textContent=value.split('\n').map((_,i)=>i+1).join('\n');syncScroll();
 }
 // Pasting a complete generated file must not block the browser's input event.
 // Coalesce paints and attach the syntax layer in one DOM operation.
 function scheduleHighlight(){if(!paintFrame)paintFrame=requestAnimationFrame(()=>{paintFrame=0;highlight();});}
 function syncScroll(){paint.scrollTop=editor.scrollTop;paint.scrollLeft=editor.scrollLeft;numbers.scrollTop=editor.scrollTop;}
 function status(message){$('source-status').textContent=message;}
 function drawTabs(){tabs.replaceChildren();for(const name of opened){const b=node('button',(drafts.has(name)?'• ':'')+name.split('/').at(-1));b.title=name;b.dataset.path=name;b.setAttribute('aria-current',String(name===active));b.onclick=()=>select(name);tabs.append(b);}}
 function drawTree(){tree.replaceChildren();const query=search.value.trim().toLowerCase(),groups=new Map();
  for(const name of Object.keys(files).sort((a,b)=>a==='mobile.json'?-1:b==='mobile.json'?1:a.localeCompare(b))){if(query&&!name.toLowerCase().includes(query))continue;const parts=name.split('/');let parent=tree,prefix='';for(const part of parts.slice(0,-1)){prefix+=part+'/';if(!groups.has(prefix)){const d=node('details');d.open=query!==''||prefix==='web/'||prefix==='expo/';d.append(node('summary',part));parent.append(d);groups.set(prefix,d);}parent=groups.get(prefix);}const b=node('button',(drafts.has(name)?'• ':'')+parts.at(-1));b.dataset.file=name;b.title=name;b.setAttribute('aria-current',name===active?'page':'false');b.onclick=()=>select(name);parent.append(b);}
 }
 function select(name){active=name;if(!opened.includes(name))opened.push(name);editor.value=drafts.get(name)??files[name]??'';$('source-path').textContent=name;editor.scrollTop=0;editor.scrollLeft=0;drawTree();drawTabs();highlight();status(drafts.has(name)?'مسودة غير محفوظة · '+name:'ملف محفوظ · '+name);$('source-apply').textContent=name==='mobile.json'?'فحص وتطبيق':'حفظ الملف';}
 function reset(){epoch++;task='';revision=-1;files={};drafts.clear();opened=['mobile.json'];active='mobile.json';tag='';select(active);}
 async function load(force=false){const current=context();if(!force&&task===current.taskId&&revision===current.project.revision)return;
  const changingTask=task!==current.taskId;if(changingTask){drafts.clear();files={};opened=['mobile.json'];active='mobile.json';}task=current.taskId;revision=current.project.revision;
  files['mobile.json']=JSON.stringify(current.project,null,2);if(active==='mobile.json'&&!drafts.has(active))select(active);
  if(!task){status('احفظ المشروع لإظهار ملفات التطبيق المولّدة.');drawTree();return;}
  const serial=++epoch,requestTask=task;status('جارٍ قراءة ملفات التطبيق…');
  try{const data=await mobileRequest('source',requestTask);if(serial!==epoch||requestTask!==context().taskId)return;
   files=data.files;tag=data.tag;revision=data.project.revision;select(active in files||drafts.has(active)?active:'mobile.json');if(drafts.size)status('احتفظنا بمسوداتك. تغيّر المشروع؛ راجع الملفات قبل الحفظ.');else if(data.externalChanges?.length)status('توجد تعديلات في الطرفية: '+data.externalChanges.join('، ')+' · افتح الملف ثم اختر استيراد تعديل الطرفية.');else if(data.overrides?.includes(active))status('ملف مخصص · يبقى محفوظًا عند تحديث التصميم. استخدم إعادة توليد الملف لمطابقته مع المخطط.');
  }catch(e){if(serial===epoch)status(e.message);}
 }
 function guard(){if(busy)throw Error('انتظر اكتمال حفظ الملف.');if(hasUnsaved())throw Error('احفظ تعديلات التصميم أولًا، ثم حدّث الملفات.');if(!task)throw Error('احفظ المشروع أولًا.');}
 async function save(action){try{guard();busy=true;$('source-apply').disabled=true;
   if(active==='mobile.json'&&!action){let candidate;try{candidate=JSON.parse(editor.value);}catch{status('JSON غير صالح. راجع الأقواس والفواصل؛ لم يتغير المشروع.');return;}if(await applySource(candidate)){drafts.delete(active);revision=-1;await load(true);status('اجتاز المخطط الفحص وحُفظ. يمكنك التراجع عن التغيير.');}return;}
   const data=await mobileRequest('source',task,{path:active,content:editor.value,expectedRevision:revision,tag,action});drafts.delete(active);files=data.files;tag=data.tag;revision=data.project.revision;acceptSaved(data);select(active);status('حُفظ '+active+' · المعاينة محدّثة');onLog('حفظ الملف: '+active);
  }catch(e){status(e.message);onLog('خطأ: '+e.message);}finally{busy=false;$('source-apply').disabled=false;}}
 editor.oninput=()=>{if(editor.value===(files[active]??''))drafts.delete(active);else drafts.set(active,editor.value);scheduleHighlight();drawTabs();status('مسودة غير محفوظة · '+active);};editor.onscroll=syncScroll;
 editor.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();void save();}if(e.key==='Tab'){e.preventDefault();const start=editor.selectionStart;editor.setRangeText('  ',start,editor.selectionEnd,'end');editor.dispatchEvent(new Event('input'));}});
 search.oninput=drawTree;add.onclick=()=>{const name=prompt('مسار ملف ويب جديد، مثل web/components.js');if(!name)return;if(!/^web\/[\w/-]+\.(?:js|css|html|json)$/.test(name)||name.includes('..')){status('استخدم مسارًا داخل web وامتداد js أو css أو html أو json.');return;}if(!(name in files)){files[name]='';drafts.set(name,'');}select(name);editor.focus();};
 $('source-apply').onclick=()=>save();$('source-reset').onclick=()=>{if(!drafts.has(active)||confirm('استبدال مسودة الملف بالنسخة المحفوظة؟')){drafts.delete(active);select(active);}};
 regenerate.onclick=()=>{if(active==='mobile.json'){status('مخطط التطبيق هو المصدر الأساسي؛ استخدم سجل الإصدارات لاستعادته.');return;}if(confirm('إزالة تخصيصات هذا الملف وإعادة توليده من تصميم التطبيق؟'))void save('reset');};
 importFile.onclick=()=>{if(confirm('استيراد النسخة الموجودة في مجلد الطرفية؟ ستستبدل مسودة هذا الملف.'))void save('import');};preview.onclick=()=>{if(drafts.size){status('احفظ تعديلات الملفات قبل المعاينة.');return;}previewCode();};
 return{render(){loading=load();},load,reset,hasDraft:()=>drafts.size>0,confirmLeave:()=>!drafts.size||confirm('هناك تعديلات في ملفات التطبيق لم تُحفظ. هل تريد تركها؟'),getTag:async()=>{await loading;const data=await mobileRequest('source',context().taskId);return data.tag;}};
}
