// Direct scene tools share the editor's revision, undo and autosave pipeline.
export function installCreativeTools({root,s,TransformControls,edit,change,panels,status}) {
  const T=s.THREE;
  const transform=s.transform=new TransformControls(s.camera,s.renderer.domElement);
  const helper=s.transformHelper=transform.getHelper();s.world.add(helper);
  transform.setSize(.8);transform.setMode('translate');
  s.transformMode='translate';s.transformSpace='world';
  let before=null,dragId=null;
  const buttons=document.createElement('div');buttons.className='creative-direct-tools';
  buttons.innerHTML=`<div role="group" aria-label="أدوات تحويل العنصر"><button data-transform="translate" aria-pressed="true" title="تحريك · W">تحريك <kbd>W</kbd></button><button data-transform="rotate" aria-pressed="false" title="تدوير · E">تدوير <kbd>E</kbd></button><button data-transform="scale" aria-pressed="false" title="تحجيم · R">تحجيم <kbd>R</kbd></button></div><select data-space aria-label="محاور التحويل"><option value="world">محاور العالم</option><option value="local">محاور العنصر</option></select><label><input data-snap type="checkbox">التقاط الشبكة</label><select data-view aria-label="زاوية العرض"><option value="perspective">منظور</option><option value="front">أمامي</option><option value="side">جانبي</option><option value="top">علوي</option></select><button data-focus title="تأطير العنصر · F">تأطير المحدد <kbd>F</kbd></button>`;
  root.querySelector('.creative-toolbar').after(buttons);
  const search=document.createElement('input');search.type='search';search.placeholder='ابحث في عناصر المشهد';search.setAttribute('aria-label','بحث عناصر المشهد');search.dataset.objectSearch='';
  root.querySelector('[data-objects]').before(search);
  const resolution=document.createElement('select');resolution.dataset.resolution='';resolution.setAttribute('aria-label','دقة صورة PNG');resolution.innerHTML='<option value="viewport">حجم المعاينة</option><option value="1920">Full HD · 1920 × 1080</option><option value="3840">4K · 3840 × 2160</option>';
  root.querySelector('[data-export]').before(resolution);
  const preset=document.createElement('select');preset.dataset.materialPreset='';preset.setAttribute('aria-label','خامة جاهزة');preset.innerHTML='<option value="">تطبيق خامة على المحدد…</option><option value="ceramic">خزف</option><option value="metal">معدن مصقول</option><option value="gold">ذهب</option><option value="clay">طين</option><option value="plastic">بلاستيك</option>';
  buttons.append(preset);
  const materialPresets={ceramic:{color:'#e8dfcf',metalness:0,roughness:.28},metal:{color:'#b8c1ca',metalness:1,roughness:.2},gold:{color:'#d6ad55',metalness:1,roughness:.24},clay:{color:'#b77c60',metalness:0,roughness:.9},plastic:{color:'#76b5a4',metalness:0,roughness:.45}};
  function filter(){const q=search.value.trim().toLocaleLowerCase();root.querySelectorAll('[data-select]').forEach(el=>{el.hidden=!el.textContent.toLocaleLowerCase().includes(q);});}
  function stopMotion(){s.playing=false;s.time=0;root.querySelector('[data-action=play]').innerHTML='<loam-icon name="play"></loam-icon>';}
  function mode(value){if(s.dragging)return;stopMotion();s.transformMode=value;transform.setMode(value);buttons.querySelectorAll('[data-transform]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.transform===value)));}
  function view(value,focus=false){if(s.dragging)return;const object=s.meshes.get(s.selected);const box=new T.Box3().setFromObject(object?.visible?object:s.group);const target=box.isEmpty()?new T.Vector3():box.getCenter(new T.Vector3());const distance=Math.max(3,box.isEmpty()?8:box.getSize(new T.Vector3()).length()*1.5);const direction=value==='front'?[0,0,1]:value==='side'?[1,0,0]:value==='top'?[0,1,.0001]:[1,.7,1];
    if(focus){const delta=s.camera.position.clone().sub(s.controls.target);if(delta.lengthSq())direction.splice(0,3,...delta.normalize().toArray());}
    s.controls.target.copy(target);s.camera.position.copy(target).add(new T.Vector3(...direction).normalize().multiplyScalar(distance));s.controls.update();status(s,'زاوية معاينة · استخدم حفظ زاوية العرض لتثبيتها');}
  buttons.addEventListener('click',e=>{const b=e.target.closest('button');if(b?.dataset.transform)mode(b.dataset.transform);if(b?.hasAttribute('data-focus'))view('perspective',true);},{signal:s.abort.signal});
  buttons.addEventListener('change',e=>{const t=e.target;if(t.hasAttribute('data-space')){s.transformSpace=t.value;transform.setSpace(t.value);}if(t.hasAttribute('data-snap')){transform.setTranslationSnap(t.checked?.5:null);transform.setRotationSnap(t.checked?Math.PI/12:null);transform.setScaleSnap(t.checked?.1:null);}if(t.hasAttribute('data-view'))view(t.value);if(t.hasAttribute('data-material-preset')){const n=s.scene.nodes.find(n=>n.id===s.selected);if(n&&materialPresets[t.value])edit(s,()=>{n.material={...materialPresets[t.value]};});t.value='';}},{signal:s.abort.signal});
  search.addEventListener('input',filter,{signal:s.abort.signal});
  transform.addEventListener('dragging-changed',e=>{s.dragging=e.value;s.controls.enabled=!e.value;});
  transform.addEventListener('mouseDown',()=>{stopMotion();clearTimeout(s.saveTimer);before=structuredClone(s.scene);dragId=s.selected;s.dragging=true;});
  transform.addEventListener('objectChange',()=>{const n=s.scene.nodes.find(n=>n.id===dragId),object=transform.object;if(!before||!n||!object)return;
    n.position=object.position.toArray().map(v=>Math.max(-10000,Math.min(10000,v)));n.rotation=[object.rotation.x,object.rotation.y,object.rotation.z].map(v=>Math.max(-10000,Math.min(10000,v)));n.scale=object.scale.toArray().map(v=>Math.max(.01,Math.min(100,v)));object.position.fromArray(n.position);object.rotation.set(...n.rotation);object.scale.fromArray(n.scale);
  });
  function commit(){if(!before)return;const original=before.nodes.find(n=>n.id===dragId),current=s.scene.nodes.find(n=>n.id===dragId);if(JSON.stringify(original)!==JSON.stringify(current)){s.undo.push(before);if(s.undo.length>60)s.undo.shift();s.redo=[];change(s);}before=null;dragId=null;s.dragging=false;s.controls.enabled=true;panels(s);}
  transform.addEventListener('mouseUp',()=>{s.ignoreSelectionUntil=performance.now()+100;commit();});
  s.renderer.domElement.addEventListener('pointercancel',()=>{transform.dragging=false;commit();},{signal:s.abort.signal});
  // Scope shortcuts to this editor; typing in names and numeric fields is untouched.
  root.tabIndex=0;
  root.addEventListener('pointerdown',e=>{if(e.target===s.renderer.domElement)root.focus({preventScroll:true});},{signal:s.abort.signal});
  root.addEventListener('keydown',e=>{if(e.target.closest('input,textarea,select,[contenteditable=true]')||s.loading||s.dragging)return;const key=e.key.toLowerCase();let action;
    if((e.ctrlKey||e.metaKey)&&key==='s')action='save';else if((e.ctrlKey||e.metaKey)&&key==='z')action=e.shiftKey?'redo':'undo';else if((e.ctrlKey||e.metaKey)&&key==='y')action='redo';else if((e.ctrlKey||e.metaKey)&&key==='d')action='clone';else if(e.ctrlKey||e.metaKey||e.altKey)return;else if(['w','e','r'].includes(key)){e.preventDefault();mode({w:'translate',e:'rotate',r:'scale'}[key]);return;}else if(key==='f'){e.preventDefault();view('perspective',true);return;}else if(key==='delete')action='delete';else if(key===' '){action='play';}if(action){e.preventDefault();root.querySelector(`[data-action="${action}"]`)?.click();}
  },{signal:s.abort.signal});
  let lastObject,lastVisible,lastList;
  return {update(){const selected=s.meshes.get(s.selected),list=root.querySelector('[data-objects]').firstChild;if(lastObject===selected&&lastVisible===selected?.visible&&lastList===list)return;lastObject=selected;lastVisible=selected?.visible;lastList=list;if(selected?.visible){if(transform.object!==selected)transform.attach(selected);}else transform.detach();preset.disabled=!selected;filter();},dispose(){commit();transform.detach();s.world.remove(helper);transform.dispose();buttons.remove();search.remove();resolution.remove();}};
}
