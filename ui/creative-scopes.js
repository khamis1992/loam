import {colorFields} from './creative-color.js';
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** Track-level settings shown in the inspector for the selected clip's track: blend mode + adjustment layer color. */
export function trackPanel(track){
  if(!track||track.kind!=='visual')return '';
  const adjust=track.colorAdjust||{};
  return `<section data-track-panel><h3>إعدادات المسار «${esc(track.name)}»</h3>
    <label>وضع المزج<select data-track-blend>${[['normal','عادي'],['multiply','ضرب'],['screen','شاشة'],['overlay','تراكب'],['darken','أغمق'],['lighten','أفتح'],['difference','فرق']].map(([value,label])=>`<option value="${value}" ${track.blend===value?'selected':''}>${label}</option>`).join('')}</select></label>
    <label><input type="checkbox" data-track-adjust ${track.adjust?'checked':''}>طبقة تعديل (تصحيح اللون يطبق على ما تحتها)</label>
    ${track.adjust?colorFields.map(([key,label,min,max,value])=>`<label>${label}<input type="number" data-track-color="${key}" min="${min}" max="${max}" step="${key==='hue'?1:.05}" value="${adjust[key]??value}"></label>`).join(''):'<p class="creative-help">فعّل طبقة التعديل لضبط تصحيح اللون العام.</p>'}
  </section>`;
}
/** Color analysis scopes (histogram, luma waveform, vectorscope) reading the preview canvas. */
export function scopesPanel(){
  return `<section class="tl-scopes"><h3>مقاييس اللون</h3><div>
    <figure><figcaption>Histogram</figcaption><canvas width="128" height="72" data-scope="histogram"></canvas></figure>
    <figure><figcaption>Waveform</figcaption><canvas width="128" height="72" data-scope="waveform"></canvas></figure>
    <figure><figcaption>Vectorscope</figcaption><canvas width="72" height="72" data-scope="vectorscope"></canvas></figure>
  </div></section>`;
}
export function updateScopes(root,sourceCanvas){
  const ctx=sourceCanvas.getContext('2d');
  const width=sourceCanvas.width,height=sourceCanvas.height;
  const step=Math.max(1,Math.floor(Math.min(width,height)/160));
  const image=ctx.getImageData(0,0,width,height).data;
  const histogram=root.querySelector('[data-scope="histogram"]');
  const waveform=root.querySelector('[data-scope="waveform"]');
  const vectorscope=root.querySelector('[data-scope="vectorscope"]');
  if(!histogram||!waveform||!vectorscope)return;
  const bins=new Array(256).fill(0);
  const wave=waveform.getContext('2d');
  wave.fillStyle='#0d1620';wave.fillRect(0,0,128,72);
  const vec=vectorscope.getContext('2d');
  vec.fillStyle='#0d1620';vec.fillRect(0,0,72,72);
  vec.strokeStyle='#3c526b';vec.beginPath();vec.arc(36,36,30,0,Math.PI*2);vec.stroke();
  vec.strokeStyle='#58e6d3';
  let vectorSamples=0;
  for(let y=0;y<height;y+=step)for(let x=0;x<width;x+=step){
    const i=(y*width+x)*4,r=image[i],g=image[i+1],b=image[i+2];
    bins[Math.round(.299*r+.587*g+.114*b)]++;
    if(waveform&&x%step===0){const luma=.299*r+.587*g+.114*b;const wx=x/width*128,wy=72-luma/255*68;wave.fillStyle=`rgba(88,230,211,.25)`;wave.fillRect(wx,wy,1,1);}
    if(vectorSamples<4000){const u=-.147*r-.289*g+.436*b,v=.615*r-.515*g-.100*b;vec.fillStyle='rgba(224,160,106,.35)';vec.fillRect(36+u*60,36-v*60,1,1);vectorSamples++;}
  }
  const hist=histogram.getContext('2d');
  hist.fillStyle='#0d1620';hist.fillRect(0,0,128,72);
  const max=Math.max(...bins,1);
  hist.fillStyle='#58e6d3';
  for(let bin=0;bin<256;bin++)hist.fillRect(bin/2,72-bins[bin]/max*68,.5,bins[bin]/max*68);
}
