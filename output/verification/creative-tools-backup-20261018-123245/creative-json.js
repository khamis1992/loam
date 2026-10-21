// Portable scene files keep the existing scene schema and embed task-local GLBs.
const MAX_FILE=100*1024*1024;
export function validateSceneJSON(v){
  const fail=()=>{throw Error('ملف JSON ليس مشهد Loam صالحًا أو يحتوي قيمًا خارج الحدود.');};
  const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
  const num=(x,min,max)=>typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max;
  const str=(x,max)=>typeof x==='string'&&x.trim()&&x.length<=max;
  const vec=(x,min=-10000,max=10000)=>Array.isArray(x)&&x.length===3&&x.every(n=>num(n,min,max));
  const color=x=>typeof x==='string'&&/^#[a-f\d]{6}$/i.test(x);
  if(!obj(v)||v.version!==1||!str(v.title,300)||!Array.isArray(v.nodes)||v.nodes.length>200||!num(v.duration,1,60))fail();
  const e=v.environment,c=v.camera,ids=new Set();
  if(!obj(e)||!color(e.background)||!num(e.lightIntensity,0,10)||!num(e.exposure,.1,5)||typeof e.grid!=='boolean'||!obj(c)||!vec(c.position)||!vec(c.target)||!num(c.fov,20,100))fail();
  for(const n of v.nodes){
    if(!obj(n)||!str(n.id,100)||!/^[a-z\d_-]+$/i.test(n.id)||ids.has(n.id)||!str(n.name,200)||!['box','sphere','cylinder','torus','plane','cone','model'].includes(n.type)||!vec(n.position)||!vec(n.rotation,-1000,1000)||!vec(n.scale,.01,100)||typeof n.visible!=='boolean'||!num(n.spin,-20,20)||!obj(n.material)||!color(n.material.color)||!num(n.material.metalness,0,1)||!num(n.material.roughness,0,1))fail();
    ids.add(n.id);
    if(n.type==='model'&&(!str(n.asset,400)||!n.asset.endsWith('.glb')||/[:\\]/.test(n.asset)||n.asset.split('/').some(p=>!p||p==='.'||p==='..')))fail();
  }
  // Explicitly rebuild the schema: file revision and arbitrary properties never enter live state.
  return {version:1,title:v.title,nodes:v.nodes.map(n=>({id:n.id,name:n.name,type:n.type,position:[...n.position],rotation:[...n.rotation],scale:[...n.scale],material:{color:n.material.color,metalness:n.material.metalness,roughness:n.material.roughness},visible:n.visible,spin:n.spin,...(n.type==='model'?{asset:n.asset}:{})})),environment:{background:e.background,lightIntensity:e.lightIntensity,exposure:e.exposure,grid:e.grid},camera:{position:[...c.position],target:[...c.target],fov:c.fov},duration:v.duration};
}
export async function exportSceneJSON(scene,taskId){
  const output=structuredClone(scene),assets=Object.create(null);let total=0;
  for(const asset of new Set(scene.nodes.filter(n=>n.type==='model').map(n=>n.asset))){
    const response=await fetch('/api/media?taskId='+encodeURIComponent(taskId)+'&path='+encodeURIComponent(asset));
    if(!response.ok)throw Error('تعذّر تضمين نموذج في JSON: '+asset);
    const blob=await response.blob();total+=blob.size;
    if(total>70*1024*1024)throw Error('أصول المشهد أكبر من حد JSON المحمول (70 MB).');
    assets[asset]=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);});
  }
  output.assets=assets;return new Blob([JSON.stringify(output,null,2)],{type:'application/json'});
}
export async function readSceneJSON(file){
  if(file.size>MAX_FILE)throw Error('حجم ملف JSON يتجاوز 100 MB.');
  let data;try{data=JSON.parse(await file.text());}catch{throw Error('تعذّر قراءة JSON. تحقق من صحة الملف.');}
  const scene=validateSceneJSON(data),assets=new Map();
  for(const path of new Set(scene.nodes.filter(n=>n.type==='model').map(n=>n.asset))){
    const encoded=data.assets?.[path];if(encoded===undefined)continue;
    if(typeof encoded!=='string'||encoded.length>35*1024*1024||encoded.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw Error('بيانات نموذج مضمّن غير صالحة.');
    const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
    if(bytes.length<20||bytes.length>25*1024*1024||new DataView(bytes.buffer).getUint32(0,true)!==0x46546c67)throw Error('ملف GLB المضمّن غير صالح.');
    assets.set(path,bytes);
  }
  return {scene,assets};
}
