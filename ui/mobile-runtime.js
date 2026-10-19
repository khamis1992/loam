// Shared by the studio preview and the standalone exported app. No external assets.
import {resolveMobileDesign,readableInk} from './mobile-design.js';
import {mountRecords} from './mobile-records.js';
const mobileMounts=new WeakMap();
export function mountMobile(root, project, storageKey, initialScreen, options={}) {
 mobileMounts.get(root)?.();
 let recordCleanups=[];
 const cleanup=()=>{recordCleanups.forEach(fn=>fn());recordCleanups=[];};
 mobileMounts.set(root,cleanup);
 const primary=project.screens.filter((s,i)=>s.kind?s.kind==='primary':i<5);
 let values={},active=initialScreen||primary[0]?.id||project.screens[0].id,trail=[...(options.trail||[])].filter(id=>project.screens.some(s=>s.id===id));
 const byId=id=>project.screens.find(s=>s.id===id);
 const section=id=>{let s=byId(id),seen=new Set();while(s?.parentId&&!seen.has(s.id)){seen.add(s.id);s=byId(s.parentId);}return s?.id;};
 function navigate(id){if(!byId(id)||id===active)return;if(primary.some(s=>s.id===id))trail=[];else trail=[...trail,active].slice(-100);active=id;render();root.querySelector('h1')?.focus();options.onScreen?.(active,[...trail]);}
 function back(){const previous=trail.pop()||byId(active)?.parentId||primary[0]?.id;if(!previous)return;active=previous;render();root.querySelector('h1')?.focus();options.onScreen?.(active,[...trail]);}
 try{values=JSON.parse(localStorage.getItem(storageKey)||'{}');if(!values||typeof values!=='object'||Array.isArray(values))values={};}catch{}
 const save=async()=>{localStorage.setItem(storageKey,JSON.stringify(values));if(window.__loamFlush)await window.__loamFlush();};
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const icons={book:'M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4z M12 6v15',briefcase:'M8 6V4h8v2 M3 7h18v13H3z M3 12c6 3 12 3 18 0 M10 13h4',spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',check:'m5 12 4 4L19 6',sun:'M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2 M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0',flag:'M5 21V4 M5 4c5-4 9 4 14 0v10c-5 4-9-4-14 0',note:'M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5',target:'M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0 M17 12a5 5 0 1 0-10 0 5 5 0 0 0 10 0 M12 10v4 M10 12h4'};
 const icon=name=>{const n=document.createElementNS('http://www.w3.org/2000/svg','svg'),p=document.createElementNS(n.namespaceURI,'path');n.setAttribute('viewBox','0 0 24 24');n.setAttribute('fill','none');n.setAttribute('stroke','currentColor');n.setAttribute('stroke-width','1.6');n.setAttribute('stroke-linecap','round');n.setAttribute('stroke-linejoin','round');n.setAttribute('aria-hidden','true');p.setAttribute('d',icons[name]||icons.note);n.append(p);return n;};
 const design=resolveMobileDesign(project);
 // Clear the previous profile when undo restores a legacy project on the same root.
 for(const name of Array.from(root.style))if(name.startsWith('--ds-'))root.style.removeProperty(name);
 root.classList.toggle('designed',!!design);root.dataset.designProfile=design?.profile||'legacy';
 if(design){for(const [key,value]of Object.entries(design.tokens))root.style.setProperty('--ds-'+key,value);root.style.setProperty('--ds-radius',design.radius);}
 function render(){
  cleanup();
  root.replaceChildren();root.dir=project.direction;root.classList.toggle('editing',!!options.edit);root.style.setProperty('--app-accent',project.accent);root.style.setProperty('--accent-ink',readableInk(project.accent));
  const screen=project.screens.find(s=>s.id===active)||project.screens[0],header=el('header'),brand=el('span',project.title),mark=el('span',project.title.trim().slice(0,1),'app-mark');mark.setAttribute('aria-hidden','true');header.append(mark,brand);
  const title=el('h1',screen.title),main=el('main'),notice=el('output'),hero=el('section',undefined,'app-hero'),progress=el('section',undefined,'app-progress');root.classList.toggle('polished',!!screen.design);root.classList.toggle('primary-screen',screen.kind==='primary');main.classList.toggle('destinations-grid',!!screen.design&&screen.kind==='primary'&&screen.blocks.length>1&&screen.blocks.every(b=>b.type==='button'&&b.target));notice.setAttribute('aria-live','polite');title.tabIndex=-1;
  const services=options.services;
  if(services&&window.loam){
   const account=el('section',undefined,'app-account'),accountToggle=el('button',services.user?'حسابي':'تسجيل الدخول','app-account-toggle');account.hidden=!services.authRequired;
   accountToggle.type='button';accountToggle.onclick=()=>{account.hidden=!account.hidden;};header.append(accountToggle);
   if(services.user){
    const logout=el('button','تسجيل الخروج');logout.type='button';logout.onclick=async()=>{logout.disabled=true;try{await window.loam.auth.logout();}catch(e){notice.textContent=e.message;logout.disabled=false;}};account.append(el('p',services.user.email),logout);
    const files=el('details'),summary=el('summary','ملفاتي'),list=el('div'),upload=el('input'),fileStatus=el('output');upload.type='file';upload.setAttribute('aria-label','إرفاق ملف');
    const loadFiles=async()=>{const data=await window.loam.files.list();list.replaceChildren();for(const file of data.files){const download=el('button',file.name);download.type='button';download.onclick=async()=>{try{await window.loam.files.download(file.id);fileStatus.textContent='بدأ تنزيل الملف';}catch(e){fileStatus.textContent=e.message;}};list.append(download);}};
    files.ontoggle=()=>{if(files.open)void loadFiles().catch(e=>fileStatus.textContent=e.message);};
    upload.onchange=async()=>{const file=upload.files[0];if(!file)return;if(file.size>2000000){fileStatus.textContent='الحد الأقصى للملف 2 MB';return;}upload.disabled=true;try{const bytes=new Uint8Array(await file.arrayBuffer());let content='';for(const byte of bytes)content+=String.fromCharCode(byte);await window.loam.files.upload(file.name,btoa(content),file.type||'application/octet-stream');await loadFiles();fileStatus.textContent='حُفظ الملف محليًا';}catch(e){fileStatus.textContent=e.message;}finally{upload.disabled=false;}};files.append(summary,upload,list,fileStatus);account.append(files);
   }else{
    const heading=el(services.authRequired?'h2':'p','مرحبًا بك'),form=el('form'),email=el('input'),password=el('input'),login=el('button','دخول'),register=el('button','إنشاء حساب'),result=el('p');result.setAttribute('role','status');email.type='email';email.autocomplete='username';email.required=true;email.setAttribute('aria-label','البريد الإلكتروني');email.placeholder='البريد الإلكتروني';password.type='password';password.autocomplete='current-password';password.minLength=10;password.required=true;password.setAttribute('aria-label','كلمة المرور');password.placeholder='كلمة المرور · 10 أحرف على الأقل';login.type=register.type='button';
    const submit=async action=>{if(!form.reportValidity())return;login.disabled=register.disabled=true;result.textContent='جارٍ الاتصال…';try{await window.loam.auth[action](email.value,password.value);}catch(e){result.textContent=e.message;login.disabled=register.disabled=false;}};form.onsubmit=e=>e.preventDefault();login.onclick=()=>void submit('login');form.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();void submit('login');}};register.onclick=()=>void submit('register');form.append(email,password,login,register,result);account.append(heading,el('p','حساب محلي لهذا التطبيق. تحفظ بياناتك في Loam على هذا الجهاز.'),form);
   }
   if(services.authRequired&&!options.edit){root.append(header,account);return;}
   header.after(account);root.append(account);
  }
  if(screen.kind==='detail'){const button=el('button',project.direction==='rtl'?'رجوع':'Back','app-back');button.type='button';button.onclick=back;header.append(button);}
  if(screen.design){const emblem=el('span',undefined,'hero-icon');emblem.append(icon(screen.design.icon));hero.append(emblem);if(screen.design.eyebrow.trim()!==screen.title.trim())hero.append(el('p',screen.design.eyebrow,'app-eyebrow'));hero.append(title,el('p',screen.design.description,'app-description'));}
  const sectionToggles=project.screens.filter(s=>section(s.id)===section(screen.id)).flatMap(s=>s.blocks).filter(b=>b.type==='toggle');
  const updateProgress=()=>{if(!screen.design||screen.kind!=='primary'||!sectionToggles.length)return;const done=sectionToggles.filter(b=>values[b.id]===true).length,ar=project.direction==='rtl',row=el('div',undefined,'progress-heading'),track=el('div',undefined,'progress-track'),fill=el('i');row.append(el('span',ar?'تقدمك في هذا القسم':'Section progress'),el('strong',done+' / '+sectionToggles.length));track.setAttribute('role','progressbar');track.setAttribute('aria-label',ar?'الخطوات المكتملة':'Completed steps');track.setAttribute('aria-valuenow',String(done));track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax',String(sectionToggles.length));fill.style.width=(done/sectionToggles.length*100)+'%';track.append(fill);progress.replaceChildren(row,track,el('p',ar?'يُحتسب من الخطوات التي علّمتها مكتملة.':'Based on the steps you marked complete.'));};
  updateProgress();
  for(const block of screen.blocks){
   let node;
   if(block.type==='collection'){node=el('section');node.setAttribute('aria-label',block.text);recordCleanups.push(mountRecords(node,project,block.collectionId,storageKey));}
   else if(block.type==='heading'||block.type==='text')node=el(block.type==='heading'?'h2':'p',block.text,block.type==='heading'?'hero-heading':'body-copy');
   else if(block.type==='button'){node=el('button',block.text,'app-action');node.type='button';if(screen.design&&block.target){node.setAttribute('aria-label',block.text);const destination=byId(block.target),symbol=el('span',undefined,'destination-icon'),copy=el('span',undefined,'destination-copy'),arrow=el('span',project.direction==='rtl'?'←':'→','destination-arrow');symbol.append(icon(destination?.design?.icon));copy.append(el('strong',block.text));if(destination?.design?.description)copy.append(el('small',destination.design.description));const toggles=destination?.blocks.filter(b=>b.type==='toggle')||[];if(toggles.length&&toggles.every(b=>values[b.id]===true))copy.append(el('em',project.direction==='rtl'?'مكتملة':'Complete','destination-state'));arrow.setAttribute('aria-hidden','true');node.className='destination-card';node.replaceChildren(symbol,copy,arrow);}node.onclick=async()=>{if(block.target)navigate(block.target);else{node.disabled=true;notice.textContent='جارٍ الحفظ…';try{await save();notice.textContent='تم حفظ البيانات على هذا الجهاز';}catch(e){notice.textContent=e.message||'تعذّر الحفظ على هذا الجهاز';}finally{node.disabled=false;}}};}
   else{node=el('label',undefined,block.type==='toggle'?'toggle-card':'field');const input=el('input');input.type=block.type==='toggle'?'checkbox':'text';input.setAttribute('aria-label',block.text);if(block.placeholder)input.placeholder=block.placeholder;if(block.type==='toggle')input.checked=values[block.id]===true;else input.value=typeof values[block.id]==='string'?values[block.id]:'';input.oninput=()=>{values[block.id]=block.type==='toggle'?input.checked:input.value;void save().catch(e=>notice.textContent=e.message||'تعذّر الحفظ');updateProgress();};node.append(el('span',block.text),input);if(block.help){const help=el('small',block.help,'field-help');help.id='help-'+block.id;input.setAttribute('aria-describedby',help.id);node.append(help);}}
   if(options.edit){const wrapper=el('div',undefined,'editable');wrapper.dataset.blockId=block.id;wrapper.dataset.selected=String(block.id===options.selected);node.inert=true;const select=el('button',undefined,'select-overlay');select.type='button';select.setAttribute('aria-label','تعديل: '+block.text);select.setAttribute('aria-pressed',String(block.id===options.selected));select.onclick=()=>options.onSelect?.(block.id);wrapper.append(node,select);main.append(wrapper);}else{node.dataset.blockId=block.id;main.append(node);}
  }
  const nav=el('nav');nav.setAttribute('aria-label','شاشات التطبيق');for(const [index,s]of primary.entries()){const button=el('button');button.setAttribute('aria-current',String(s.id===section(screen.id)));const glyph=el('span',undefined,'nav-number');glyph.setAttribute('aria-hidden','true');if(s.design)glyph.append(icon(s.design.icon));else glyph.textContent=String(index+1).padStart(2,'0');button.append(glyph,el('span',s.title));button.onclick=()=>navigate(s.id);nav.append(button);}
  root.append(header,screen.design?hero:title);if(progress.childNodes.length)root.append(progress);root.append(main);if(screen.design){const tip=el(screen.kind==='primary'?'details':'aside',undefined,'guidance-card'),symbol=el('span',undefined,'guidance-icon');symbol.append(icon('spark'));if(screen.kind==='primary'){const summary=el('summary',project.direction==='rtl'?'خطوة تساعدك':'A useful next step');tip.append(summary,el('p',screen.design.guidance));}else tip.append(symbol,el('strong',project.direction==='rtl'?'خطوة تساعدك':'A useful next step'),el('p',screen.design.guidance));root.append(tip);}root.append(notice,nav);root.prepend(header);
 }
 render();
 return cleanup;
}
