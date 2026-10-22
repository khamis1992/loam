const fs=require('fs');const p='ui/creative-timeline.js';let s=fs.readFileSync(p,'utf8');
function must(x){if(!s.includes(x)){console.error('MISSING:',JSON.stringify(x.slice(0,70)));process.exit(1);}}
function rep(old,nw){must(old);s=s.replace(old,nw,1);}

// 1) identity panel + templates + platform controls inside the services details (before the library toolbar)
must('<div data-tl-library class="tl-toolbar" aria-label="مكتبة أصول المشروع"></div>');
rep('<div data-tl-library class="tl-toolbar" aria-label="مكتبة أصول المشروع"></div>','<details class="tl-identity"><summary>الهوية والقوالب والمقاسات</summary><div class="tl-toolbar" data-identity-fields></div><div class="tl-toolbar"><button data-identity-apply>تطبيق الهوية على العناوين</button><button data-identity-logo>إضافة الشعار</button><label>مقاس المنصة<select data-platform-select></select></label><button data-platform-convert>تحويل نسب الأبعاد</button><label><input type="checkbox" data-safe-area>منطقة آمنة</label></div><div class="tl-toolbar" data-video-templates></div><p>الهوية تُحفظ مع المشروع وتُطبق ألوانها وخطها على العناوين؛ القوالب تُدرج عناوين قابلة للتحرير الكامل؛ تحويل الأبعاد يعيد ضبط المقاس ويموضع العناوين.</p></details><div data-tl-library class="tl-toolbar" aria-label="مكتبة أصول المشروع"></div>');

// 2) renderIdentityFields + safe-area state, called from render()
must("    renderSubtitles();");
rep("    renderSubtitles();","    renderIdentityFields();\n    renderSubtitles();");
must("  function renderMixer(){");
rep("  function renderMixer(){",
`  function renderIdentityFields(){
    if(!dialog)return;const host=dialog.querySelector('[data-identity-fields]');if(!host)return;
    const identity=project.identity??defaultIdentity();
    host.innerHTML='<label>الاسم<input data-identity-field="name" maxlength="100" value="'+esc(identity.name)+'"></label>'
      +['primary','secondary','accent','titleColor','logoColor'].map(key=>'<label>'+({primary:'اللون الأساسي',secondary:'اللون الثانوي',accent:'لون التمييز',titleColor:'لون العناوين',logoColor:'لون الشعار'}[key])+'<input type="color" data-identity-field="'+key+'" value="'+identity[key]+'"></label>').join('')
      +'<label>حجم خط العناوين<input type="number" data-identity-field="titleFont" min="12" max="200" value="'+identity.titleFont+'"></label>'
      +'<label>نص الشعار<input data-identity-field="logoText" maxlength="60" value="'+esc(identity.logoText)+'"></label>'
      +'<label>زاوية الشعار<select data-identity-corner>'+[['tl','أعلى اليسار'],['tr','أعلى اليمين'],['bl','أسفل اليسار'],['br','أسفل اليمين']].map(([v,l])=>'<option value="'+v+'" '+(identity.logoCorner===v?'selected':'')+'>'+l+'</option>').join('')+'</select></label>';
  }
  function renderMixer(){`);

// 3) handlers: identity fields, apply, logo, template, platform, safe-area
must("if(b.dataset.fxLutLoad){");
rep("if(b.dataset.fxLutLoad){",
`if(b.hasAttribute('data-identity-apply')){void run(()=>edit(()=>{project.identity??=defaultIdentity();const changed=applyIdentity(project);status(changed?('طُبقت الهوية على '+changed/2+' عنوانًا.'):'لا عناوين لتطبيق الهوية عليها.');}));return;}
      if(b.hasAttribute('data-identity-logo')){void run(()=>edit(()=>{project.identity??=defaultIdentity();if(!project.identity.logoText)throw Error('اكتب نص الشعار في الهوية أولًا.');const track=project.tracks.find(t=>t.kind==='visual'&&!t.locked);if(!track)throw Error('لا مسار مرئي مفتوح.');project.clips.push(logoClip(project.identity,track,engine.time));status('أُضيف الشعار كعنوان قابل للتحرير.');}));return;}
      if(b.dataset.videoTemplate){void run(()=>edit(()=>{const track=project.tracks.find(t=>t.kind==='visual'&&!t.locked);if(!track)throw Error('لا مسار مرئي مفتوح.');const clips=buildTemplate(b.dataset.videoTemplate,track,engine.time,project.identity);project.clips.push(...clips);selected=clips[0].id;status('أُدرج قالب «'+videoTemplates[b.dataset.videoTemplate].label+'» ('+clips.length+' عناوين قابلة للتحرير).');}));return;}
      if(b.hasAttribute('data-platform-convert')){const select=dialog.querySelector('[data-platform-select]');void run(()=>edit(()=>{const preset=convertAspect(project,select.value);project.platform=preset.id;status('تحول المشروع إلى '+preset.width+'×'+preset.height+' مع إعادة تموضع العناوين.');}));return;}
      if(b.dataset.fxLutLoad){`);

// 4) change handlers for identity fields
must("if(t.dataset.trackColor){");
rep("if(t.dataset.trackColor){",
`if(t.hasAttribute('data-identity-field')||t.hasAttribute('data-identity-corner')){void run(()=>edit(()=>{project.identity??=defaultIdentity();const key=t.dataset.identityField||'logoCorner';project.identity[key]=key==='titleFont'?Number(t.value):key==='name'||key==='logoText'?String(t.value):t.value;}));return;}
    if(t.hasAttribute('data-platform-select')){return;}
    if(t.hasAttribute('data-safe-area')){dialog.dataset.safeArea=t.checked?'1':'';render();return;}
    if(t.dataset.trackColor){`);

// 5) safe-area overlay in engine onTime draw hook: draw after scopes update instead — simplest: draw in timeline onTime callback
must("if(!playing){const scopes=dialog.querySelector('.tl-scopes');");
rep("if(!playing){const scopes=dialog.querySelector('.tl-scopes');",
"if(dialog.dataset.safeArea&&engine.project){const preset=platformSizes.find(x=>x.id===engine.project.platform);engine.safeFraction=preset?.safe??0.05;}else engine.safeFraction=0;\n    if(!playing){const scopes=dialog.querySelector('.tl-scopes');");
fs.writeFileSync(p,s);console.log('ui10 applied');
