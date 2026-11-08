import { gameScene, type GameScene } from './scene.js';

export const STEP_SOURCE = `function step(state, input, tuning) {
  if (state.status !== 'play') return state;
  const speed = Math.min(500, Math.max(50, Number(tuning.speed)));
  const gravity = Math.min(1500, Math.max(100, Number(tuning.gravity)));
  if (!Number.isFinite(speed) || !Number.isFinite(gravity)) return state;
  const goalX = tuning.goalX === 420 ? 420 : 600;
  let x = state.x + (input.left ? -speed : input.right ? speed : 0) / 25;
  let vy = state.vy;
  let y = state.y;
  if (x < 540 && y >= 500) {
    y = 500;
    vy = input.jump ? -8 : 0;
  } else {
    vy += gravity / 700;
    y += vy;
  }
  let status = 'play';
  if (x > goalX && y < 530) status = 'goal';
  else if (y > 620 || x < -30) status = 'loss';
  return { x: x, y: y, vy: vy, status: status };
}
function restart() { return { x: 70, y: 500, vy: 0, status: 'play' }; }
`;

export interface PlayInput {
  left: boolean;
  right: boolean;
  jump: boolean;
}

export interface PlayState {
  x: number;
  y: number;
  vy: number;
  status: 'play' | 'goal' | 'loss';
}

export function startState(): PlayState {
  return { x: 70, y: 500, vy: 0, status: 'play' };
}

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function assetForms(value: string): string[] | null {
  const forms = [value];
  let current = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      forms.push(next);
      current = next;
    } catch {
      return null;
    }
  }
  return forms;
}

function leavingAsset(value: string): boolean {
  const text = value.trim().split(/[?#]/, 1)[0] ?? '';
  if (text.length === 0) return false;
  const forms = assetForms(text);
  if (!forms) return true;
  return forms.some((item) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(item)) return true;
    if (item.startsWith('//') || item.startsWith('/') || item.startsWith('\\') || /^[a-z]:/i.test(item)) return true;
    return item.split(/[/\\]/).some((part) => part === '..');
  });
}

function quotedAsset(value: string): boolean {
  const pattern = /(?:^|[\s/])(?:src|srcset|href|action|formaction|poster|background|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (leavingAsset(match[1] ?? match[2] ?? match[3] ?? '')) return true;
  }
  const urls = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;
  while ((match = urls.exec(value))) {
    if (leavingAsset(match[1] ?? match[2] ?? match[3] ?? '')) return true;
  }
  return false;
}

function activeMarkup(html: string): { tags: string[]; active: string } {
  const tags = html.match(/<[^>]+>/g) ?? [];
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  return { tags, active: `${tags.join('\n')}\n${scripts.join('\n')}` };
}

export function unsafeGamePage(html: string): boolean {
  const { tags, active } = activeMarkup(html);
  if (/https?:\/\//i.test(active) || /javascript\s*:/i.test(active)) return true;
  if (/<script\b[^>]*\ssrc\s*=\s*['"]?\s*(?:\/\/|data:|file:|blob:|javascript:)/i.test(active)) return true;
  if (/(?:\shref|\saction)\s*=\s*['"]?\s*(?:\/\/|data:|file:|blob:|javascript:)/i.test(active)) return true;
  if (/fetch\s*\(\s*['"]\s*(?:\/\/|javascript:|https?:|data:|file:|blob:)/i.test(active)) return true;
  if (tags.some((tag) => quotedAsset(tag))) return true;
  if (quotedAsset(active)) return true;
  return /\son[a-z]+\s*=/i.test(tags.join('\n'));
}

export function assertSafeGamePage(html: string): void {
  if (unsafeGamePage(html)) throw new Error('unsafe_path');
}

export function gameDocument(title = 'لعبة', scene: GameScene = gameScene(''), brief = ''): string {
  const safe = escapeText(title.replace(/https?:\/\//gi, '').trim().slice(0, 80) || 'لعبة');
  const label = escapeText(scene.label);
  const note = escapeText(brief.replace(/\u0000/g, '').trim().slice(0, 400));
  const shown = note ? `<p id="brief">${note}</p>` : '';
  const html = `<!doctype html><meta charset="utf-8"><h1>${safe}</h1><p id="scene">${label}</p>${shown}<canvas id="game" width="680" height="620" tabindex="0" aria-label="اللعبة: تحرك بالأسهم واقفز بالمسافة"></canvas>
<p>الأسهم للحركة، المسافة للقفز، \u0627\u0644\u0625\u064a\u0642\u0627\u0641: Escape أو P، R للإعادة.</p><p id="engine-note">هذه لعبة لوحة محلية. لم يُثبَّت محرك ألعاب.</p>
<label>السرعة<input id="speed" type="range" min="50" max="500" value="200"></label>
<label>الجاذبية<input id="gravity" type="range" min="100" max="1500" value="700"></label>
<p id="status" role="status" aria-live="polite"></p>
<script>
window.__errors=[];
window.onerror=function(message){window.__errors.push(String(message));};
${STEP_SOURCE}
const GOAL=${scene.goalX};
const canvas=document.querySelector('canvas');
const ctx=canvas.getContext('2d');
const keys={left:false,right:false,jump:false};
const speed=document.getElementById('speed');
const gravity=document.getElementById('gravity');
let state=restart();
let paused=false;
let running=true;
let frameId=0;
window.__frames=0;
window.__listeners=0;
const stops=[];
function listen(target,type,fn){target.addEventListener(type,fn);window.__listeners+=1;stops.push(function(){target.removeEventListener(type,fn);window.__listeners-=1;});}
function stopPreview(){if(!stops.length)return;running=false;cancelAnimationFrame(frameId);while(stops.length){stops.pop()();}}
function blockedTuning(text){
  function stripSpace(value){
    var out='';
    for(var i=0;i<value.length;i+=1){
      if(value.charCodeAt(i)>32)out+=value.charAt(i);
    }
    return out;
  }
  function schemeHit(value){
    var lowered=stripSpace(String(value).toLowerCase());
    var colon=':';
    var slash='/'+'/';
    if(lowered.indexOf('java'+'script'+colon)>=0)return true;
    if(lowered.indexOf('http'+colon+slash)>=0)return true;
    if(lowered.indexOf('https'+colon+slash)>=0)return true;
    var names=['mailto','tel','sms','intent','market','data','file','blob'];
    for(var n=0;n<names.length;n+=1){
      if(lowered.indexOf(names[n]+colon)>=0)return true;
    }
    if(lowered.indexOf(slash)>=0)return true;
    return false;
  }
  function dropSlashes(value){
    var out='';
    for(var i=0;i<value.length;i+=1){
      if(value.charCodeAt(i)!==92)out+=value.charAt(i);
    }
    return out;
  }
  function joinQuotes(value){
    var out='';
    for(var i=0;i<value.length;i+=1){
      var ch=value.charAt(i);
      if(ch==='"'||ch==="'"){
        var j=i+1;
        while(j<value.length && value.charCodeAt(j)<=32)j+=1;
        if(value.charAt(j)==='+'){
          j+=1;
          while(j<value.length && value.charCodeAt(j)<=32)j+=1;
          if(value.charAt(j)==='"'||value.charAt(j)==="'"){
            i=j;
            continue;
          }
        }
      }
      out+=ch;
    }
    return out;
  }
  function collapseQuotes(value){
    var current=dropSlashes(value);
    var previous='';
    while(current!==previous){
      previous=current;
      current=joinQuotes(current);
    }
    return current;
  }
  function decodePercents(value){
    var out='';
    for(var i=0;i<value.length;i+=1){
      var hex=value.slice(i+1,i+3);
      if(value.charAt(i)==='%' && /^[0-9a-f]{2}$/i.test(hex)){
        out+=String.fromCharCode(parseInt(hex,16));
        i+=2;
      }else{
        out+=value.charAt(i);
      }
    }
    return out;
  }
  function bare(value){
    return value.split('"').join('').split("'").join('');
  }
  var raw=String(text==null?'':text);
  var pending=[raw];
  var seen=Object.create(null);
  for(var depth=0;depth<=2;depth+=1){
    var layer=pending;
    pending=[];
    for(var i=0;i<layer.length;i+=1){
      var item=layer[i];
      if(seen[item])continue;
      seen[item]=1;
      var collapsed=collapseQuotes(item);
      if(schemeHit(item)||schemeHit(collapsed)||schemeHit(bare(item))||schemeHit(bare(collapsed)))return true;
      if(depth>=2)continue;
      var decoded=decodePercents(item);
      if(!seen[decoded])pending.push(decoded);
      var decodedCollapsed=decodePercents(collapsed);
      if(!seen[decodedCollapsed])pending.push(decodedCollapsed);
    }
  }
  return false;
}
function applyTuning(saved){
  if(!saved||typeof saved!=='object')return;
  if(blockedTuning(JSON.stringify(saved)))return;
  if(typeof saved.speed==='number'&&saved.speed>=50&&saved.speed<=500)speed.value=String(saved.speed);
  if(typeof saved.gravity==='number'&&saved.gravity>=100&&saved.gravity<=1500)gravity.value=String(saved.gravity);
}
function readTuning(){
  try {
    var text=localStorage.getItem('loam-game-tuning');
    if(text==null)return null;
    if(blockedTuning(text))return null;
    return JSON.parse(text);
  } catch (error) { return null; }
}
applyTuning(readTuning());
fetch('/tuning.json').then(function(response){return response.text();}).then(function(text){
  if(blockedTuning(text))throw new Error('invalid_tuning');
  applyTuning(JSON.parse(text));
  applyTuning(readTuning());
}).catch(function(){ applyTuning(readTuning()); });
function publish(){
  var body={speed:Number(speed.value),gravity:Number(gravity.value)};
  try { localStorage.setItem('loam-game-tuning', JSON.stringify(body)); } catch (error) {}
  fetch('/tuning',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).catch(function(){});
}
listen(speed,'input',publish);
listen(gravity,'input',publish);
listen(window,'pagehide',stopPreview);
function typingTarget(event){
  const tag=event.target&&event.target.tagName;
  return tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT';
}
function gameKey(event){
  return event.key==='ArrowRight'||event.key==='ArrowLeft'||event.key===' '||event.key==='r'||event.key==='R'||event.key==='p'||event.key==='P'||event.key==='Escape';
}
function publishState(){
  window.__x=state.x;
  window.__y=state.y;
  window.__status=state.status;
  window.__paused=paused;
  var label='';
  if(paused)label='إيقاف';
  else if(state.status==='goal')label='WIN — R to restart';
  else if(state.status==='loss')label='LOSE — R to restart';
  document.getElementById('status').textContent=label;
}
listen(window,'keydown',function(event){
  if(typingTarget(event))return;
  if(!gameKey(event))return;
  event.preventDefault();
  if(event.key==='r'||event.key==='R'){
    keys.left=false;
    keys.right=false;
    keys.jump=false;
    paused=false;
    state=restart();
    publishState();
    return;
  }
  if(event.repeat)return;
  if(event.key==='Escape'||event.key==='p'||event.key==='P'){
    paused=!paused;
    publishState();
    return;
  }
  if(event.key==='ArrowRight')keys.right=true;
  if(event.key==='ArrowLeft')keys.left=true;
  if(event.key===' ')keys.jump=true;
});
listen(window,'keyup',function(event){
  if(typingTarget(event))return;
  if(!gameKey(event))return;
  event.preventDefault();
  if(event.key==='ArrowRight')keys.right=false;
  if(event.key==='ArrowLeft')keys.left=false;
  if(event.key===' ')keys.jump=false;
});
function frame(){
  if(!running)return;
  window.__frames+=1;
  if(!paused)state=step(state,keys,{speed:speed.value,gravity:gravity.value,goalX:GOAL});
  publishState();
  ctx.fillStyle='#173024';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#2f6f4e';ctx.fillRect(GOAL,500,12,80);
  ctx.fillStyle='#f2d16b';ctx.fillRect(state.x,state.y,16,16);
  frameId=requestAnimationFrame(frame);
}
publishState();
frameId=requestAnimationFrame(frame);
</script>`;
  assertSafeGamePage(html);
  return html;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ESCAPE[char] ?? char);
}
