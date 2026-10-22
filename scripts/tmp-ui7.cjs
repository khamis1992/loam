const fs=require('fs');const p='ui/creative-timeline.js';let s=fs.readFileSync(p,'utf8');
function must(x){if(!s.includes(x)){console.error('ANCHOR MISSING:',x.slice(0,90));process.exit(1);}}
function rep(old,nw){must(old);s=s.replace(old,nw,1);}

// import fx modules
must("import {renderLibrary,installAssetTools,probeMedia,openImportDialog} from './creative-assets.js';");
s=s.replace("import {renderLibrary,installAssetTools,probeMedia,openImportDialog} from './creative-assets.js';","import {renderLibrary,installAssetTools,probeMedia,openImportDialog} from './creative-assets.js';\nimport {effectCatalog,addEffect,moveEffect,findEffect,easeLabels} from './creative-fx.js';\nimport {effectsPanel,easeEditor,drawEaseCurve} from './creative-fx-ui.js';",1);

// render(): effects panel into inspector + keyframe dots on selected clip
must("${keyframePanel(c,engine.time)}${colorPanel(c)}");
rep("${keyframePanel(c,engine.time)}${colorPanel(c)}","${keyframePanel(c,engine.time)}${easePanels(c)}${colorPanel(c)}${effectsPanel(c)}");
// easePanels helper: an editor for every first key of each animated field (keeps DOM light)
must("  function subtitleTracks(){");
rep("  function subtitleTracks(){",
"  function easePanels(c){if(!c.keyframes)return '';return Object.entries(c.keyframes).map(([field,keys])=>keys.map((key,index)=>key.ease==='bezier'||index===0?easeEditor(c,field,index):'').join('')).join('');}\n  function subtitleTracks(){");

// keyframe dots in clip boxes (only selected clip)
must("<span>${esc(c.name)}</span><small>${c.kind} · ${c.duration.toFixed(1)}s</small></button>`).join('')");
rep("<span>${esc(c.name)}</span><small>${c.kind} · ${c.duration.toFixed(1)}s</small></button>`).join('')",
"<span>${esc(c.name)}</span><small>${c.kind} · ${c.duration.toFixed(1)}s</small>${c.id===selected&&c.keyframes?Object.entries(c.keyframes).map(([field,keys])=>keys.map((key,index)=>{const local=key.time-(c.animationOffset||0);if(local<-1e-6||local>c.duration+1e-6)return '';return '<i class=\"tl-keydot\" data-keydot=\"'+field+'.'+index+'\" title=\"مفتاح '+field+' عند '+local.toFixed(2)+'ث\" style=\"right:'+(local/c.duration*100)+'%\"></i>';}).join('')).join(''):''}</button>`).join('')");

// fx + ease handlers in change delegation
must("if(t.dataset.subStyle){");
rep("if(t.dataset.subStyle){",
`if(t.hasAttribute('data-fx-enabled')){const id=t.dataset.fxEnabled;void run(()=>edit(()=>{const effect=findEffect(project.clips.find(c2=>c2.id===selected),id);if(!effect)throw Error('المؤثر غير موجود.');effect.enabled=t.checked;}));return;}
    if(t.dataset.fxParam!==undefined&&t.hasAttribute('data-fx-param')){const [id,param]=t.dataset.fxParam.split('.');const parsed=Number(t.value);void run(()=>edit(()=>{const effect=findEffect(project.clips.find(c2=>c2.id===selected),id);if(!effect)throw Error('المؤثر غير موجود.');const spec=effectCatalog[effect.type].params[param];effect.params[param]=spec&&'min'in spec?(Number.isFinite(parsed)?parsed:spec.default):(t.value??'');}));return;}
    if(t.dataset.fxCheck!==undefined&&t.hasAttribute('data-fx-check')){const [id,param]=t.dataset.fxCheck.split('.');void run(()=>edit(()=>{const effect=findEffect(project.clips.find(c2=>c2.id===selected),id);if(!effect)throw Error('المؤثر غير موجود.');effect.params[param]=t.checked;}));return;}
    if(t.hasAttribute('data-ease-mode')){const [field,index]=t.closest('[data-ease-editor]').dataset.easeEditor.split('.');void run(()=>edit(()=>{const clip=project.clips.find(c2=>c2.id===selected);const key=clip.keyframes[field][Number(index)];key.ease=t.value;if(t.value==='bezier')key.handles??={in:[.35,0],out:[.65,1]};else delete key.handles;}));return;}
    if(t.hasAttribute('data-ease-handle')){const [side,axis]=t.dataset.easeHandle.split('.');const [field,index]=t.closest('[data-ease-editor]').dataset.easeEditor.split('.');void run(()=>edit(()=>{const clip=project.clips.find(c2=>c2.id===selected);const key=clip.keyframes[field][Number(index)];key.ease='bezier';key.handles??={in:[.35,0],out:[.65,1]};key.handles[side][Number(axis)]=Number(t.value);}));return;}
    if(t.hasAttribute('data-fx-search')){const query=t.value.trim();const panel=t.closest('[data-fx-panel]');panel.querySelectorAll('[data-fx-add]').forEach(button=>{button.hidden=query&&!button.textContent.includes(query);});return;}
    if(t.dataset.subStyle){`);

// fx click delegation (add/remove/reorder + keydot select/drag)
must("if(b.hasAttribute('data-tl-copy-props')){");
rep("if(b.hasAttribute('data-tl-copy-props')){",
`if(b.dataset.fxAdd){void run(()=>edit(()=>{addEffect(project.clips.find(c2=>c2.id===selected),b.dataset.fxAdd);}));return;}
      if(b.dataset.fxRemove){void run(()=>edit(()=>{const clip=project.clips.find(c2=>c2.id===selected);clip.effects=clip.effects.filter(effect=>effect.id!==b.dataset.fxRemove);}));return;}
      if(b.dataset.fxUp||b.dataset.fxDown){void run(()=>edit(()=>{const clip=project.clips.find(c2=>c2.id===selected);const from=clip.effects.findIndex(effect=>effect.id===(b.dataset.fxUp||b.dataset.fxDown));moveEffect(clip,from,b.dataset.fxUp?from-1:from+1);}));return;}
      if(b.hasAttribute('data-tl-copy-props')){`);

// keydot pointer drag: extend existing pointerdown/up machinery
must("let drag;dialog.addEventListener('pointerdown',e=>{const clip=e.target.closest('[data-clip]');");
rep("let drag;dialog.addEventListener('pointerdown',e=>{const keydot=e.target.closest('[data-keydot]');if(keydot&&!busy){keydot.setPointerCapture(e.pointerId);drag={keydot:JSON.parse(JSON.stringify(keydot.dataset.keydot)),x:e.clientX};return;}const clip=e.target.closest('[data-clip]');");
must("dialog.addEventListener('pointerup',e=>{if(!drag)return;const d=drag;drag=null;");
rep("dialog.addEventListener('pointerup',e=>{if(!drag)return;const d=drag;drag=null;if(d.keydot){if(Math.abs(e.clientX-d.x)<4)return;const [field,index]=d.keydot.split('.');void run(()=>edit(()=>{const clip=project.clips.find(c2=>c2.id===selected);if(!clip)throw Error('اختر مقطعًا.');const keys=clip.keyframes[field];if(!keys)throw Error('المفاتيح لم تعد موجودة.');const lane=dialog.querySelector('.tl-lane');const span=Math.max(10,duration()+1);const raw=keys[index].time+(e.clientX-d.x)/lane.offsetWidth*span;const min=index>0?keys[index-1].time+1e-4:0;const max=index<keys.length-1?keys[index-0].time-1e-4:clip.duration;if(raw<min-1e-6||raw>clip.duration+1e-6)throw Error('لا يمكن تجاوز المفاتيح المجاورة أو حدود المقطع.');keys[index].time=Math.min(max===keys[index].time?raw:Math.min(raw,max),clip.duration);keys.sort((a,b2)=>a.time-b2.time);}));return;}");
fs.writeFileSync(p,s);console.log('ui7 applied');
