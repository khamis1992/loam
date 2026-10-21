/**
 * NOTICE: Clean-room original TypeScript. The feature set (scene detection from frame
 * diffs, energy-weighted highlight clipping, subject-aware reframing, transcript cue
 * building) references design ideas from Rakazo's Apache-2.0 "FilmCraft" automatic-edit
 * pipeline; no code, model or assets were copied. See docs/handoff/ARTCRAFT_ANALYSIS.md.
 *
 * All helpers are pure and take structured inputs; media access happens only through the
 * injected MediaProbe so tests run against fixtures with no real ffmpeg.
 */

export type FrameDiff={t:number;score:number};
export type EnergySample={start:number;end:number;energy:number};
export type SubjectBox={x:number;y:number;w:number;h:number};
export type SubjectFrame={t:number;boxes:SubjectBox[]};
export type TranscriptSegment={start:number;end:number;text:string};
export type Scene={index:number;start:number;end:number;peak:number};
export type AutoClip={start:number;end:number;score:number;sceneIndex:number};
export type CropRect={x:number;y:number;width:number;height:number};
export type ReframeWindow={start:number;end:number;crop:CropRect};
export type CaptionCue={index:number;start:number;end:number;text:string};

/** Injected probe. Every lane is optional; planAutoEdit records a warning for each missing one. */
export type MediaProbe={
  frameDiffs?(path:string):Promise<FrameDiff[]>;
  audioEnergy?(path:string):Promise<EnergySample[]>;
  subjects?(path:string):Promise<SubjectFrame[]>;
  transcribe?(path:string,opts?:{language?:string}):Promise<TranscriptSegment[]>;
};

const isTime=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const isUnit=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
function requireTimes(times:number[],label:string){for(let i=0;i<times.length;i++){if(!isTime(times[i]))throw Error(label+': timestamp must be a finite non-negative number');if(i>0&&times[i]!<=times[i-1]!)throw Error(label+': timestamps must be strictly ascending');}}

/** Split a video into scenes from frame-diff samples: each scene is a stretch between cut peaks. */
export function detectScenes(diffs:FrameDiff[],opts:{threshold?:number;minSceneSeconds?:number;duration?:number}={}):Scene[]{
  const threshold=opts.threshold??0.35,minScene=opts.minSceneSeconds??0.5;
  if(!isUnit(threshold))throw Error('threshold must be a number within 0..1');
  if(!isTime(minScene))throw Error('minSceneSeconds must be a finite non-negative number');
  if(!Array.isArray(diffs))throw Error('diffs must be an array');
  requireTimes(diffs.map(d=>d.t),'frame diffs');
  for(const d of diffs)if(!isUnit(d.score))throw Error('frame diffs: score must be a number within 0..1');
  const last=diffs.at(-1);
  const end=Math.max(opts.duration??last?.t??0,last?.t??0);
  if(end<=0)return [];
  const cuts:{t:number;score:number}[]=[];
  for(let i=0;i<diffs.length;i++){
    const d=diffs[i]!;
    if(d.score<threshold)continue;
    const next=diffs[i+1];
    if(next&&next.score>d.score)continue;
    const prev=cuts.at(-1);
    if(!prev)cuts.push(d);
    else if(d.t-prev.t<minScene){if(d.score>prev.score)cuts[cuts.length-1]=d;}
    else cuts.push(d);
  }
  const bounds=[0,...cuts.filter(c=>c.t>0&&c.t<end).map(c=>c.t),end];
  const scenes:Scene[]=[];
  for(let i=0;i<bounds.length-1;i++){
    const start=bounds[i]!,stop=bounds[i+1]!;
    if(stop-start<=1e-9)continue;
    const peak=Math.max(0,...cuts.filter(c=>c.t>=start&&c.t<stop).map(c=>c.score));
    scenes.push({index:scenes.length,start,end:stop,peak});
  }
  return scenes;
}

/**
 * Adaptive cut threshold from the diff-score distribution itself: median + sensitivity x MAD of
 * the scores, clamped to [0.05, 0.8]. A static 0.35 misses scrubbing noise in mostly-static
 * footage and over-cuts in already-jumpy footage; this tracks the footage. With fewer than two
 * samples (or invalid input) it falls back to the 0.35 static default.
 */
export function adaptiveThreshold(diffs:FrameDiff[],opts:{sensitivity?:number}={}):number{
  const k=opts.sensitivity??1.5;
  if(!Array.isArray(diffs)||!Number.isFinite(k)||k<=0)return 0.35;
  if(diffs.length<2)return 0.35;
  const scores=diffs.map(d=>d.score).sort((a,b)=>a-b);
  const median=scores.length%2?scores[(scores.length-1)/2]!:(scores[scores.length/2-1]!+scores[scores.length/2]!)/2;
  const dev=scores.map(s=>Math.abs(s-median)).sort((a,b)=>a-b);
  const mad=dev.length%2?dev[(dev.length-1)/2]!:(dev[dev.length/2-1]!+dev[dev.length/2]!)/2;
  return Math.min(0.8,Math.max(0.05,Math.round((median+k*mad)*1000)/1000));
}

/** Mean audio energy over [start,end) with overlap weighting; 0 when no samples cover the range. */
function meanEnergy(energy:EnergySample[],start:number,end:number){
  let sum=0,weight=0;
  for(const e of energy){
    const overlap=Math.min(e.end,end)-Math.max(e.start,start);
    if(overlap<=0)continue;
    sum+=overlap*e.energy;weight+=overlap;
  }
  return weight>0?sum/weight:0;
}

/**
 * Pick highlight ranges from scenes + energy samples: score every scene (and every
 * maxClip-sized window inside long scenes) by 60% audio energy + 40% visual peak,
 * then greedily take the best windows until targetSeconds is filled.
 */
export function pickHighlights(scenes:Scene[],energy:EnergySample[],opts:{targetSeconds:number;minClipSeconds?:number;maxClipSeconds?:number;beats?:number[];beatsTolerance?:number}):AutoClip[]{
  if(!Array.isArray(scenes)||!scenes.length)throw Error('scenes must be a non-empty array');
  let prevEnd=-Infinity;
  for(const s of scenes){
    if(!isTime(s.start)||!isTime(s.end)||s.end<=s.start)throw Error('scenes: each scene needs 0 <= start < end');
    if(s.start<prevEnd)throw Error('scenes: scenes must be ordered and non-overlapping');
    prevEnd=s.end;
  }
  requireTimes(energy.map(e=>e.start),'audio energy');
  for(const e of energy){
    if(!isTime(e.end)||e.end<=e.start)throw Error('audio energy: each sample needs start < end');
    if(!isUnit(e.energy))throw Error('audio energy: energy must be a number within 0..1');
  }
  const target=opts.targetSeconds,minClip=opts.minClipSeconds??1,maxClip=opts.maxClipSeconds??10;
  if(!isTime(target)||target<=0)throw Error('targetSeconds must be a positive number');
  if(!isTime(minClip)||!isTime(maxClip)||minClip<=0||maxClip<minClip)throw Error('minClipSeconds/maxClipSeconds must satisfy 0 < min <= max');
  const maxEnergy=Math.max(...energy.map(e=>e.energy),0)||1,maxPeak=Math.max(...scenes.map(s=>s.peak),0)||1;
  const candidates:{start:number;end:number;score:number;sceneIndex:number}[]=[];
  for(const s of scenes){
    const peakScore=0.4*(s.peak/maxPeak);
    const chunks:AutoClip[]=[];
    if(s.end-s.start<=maxClip)chunks.push({start:s.start,end:s.end,score:0.6*(meanEnergy(energy,s.start,s.end)/maxEnergy)+peakScore,sceneIndex:s.index});
    else for(let c=s.start;c<s.end;c+=maxClip){
      const stop=Math.min(c+maxClip,s.end);
      if(stop-c<minClip)continue;
      chunks.push({start:c,end:stop,score:0.6*(meanEnergy(energy,c,stop)/maxEnergy)+peakScore,sceneIndex:s.index});
    }
    if(chunks.length)candidates.push(chunks.reduce((a,b)=>b.score>a.score?b:a));
  }
  candidates.sort((a,b)=>b.score-a.score||a.start-b.start);
  const picked:AutoClip[]=[];let remaining=target;
  for(const c of candidates){
    if(remaining<minClip)break;
    const end=Math.min(c.end,c.start+remaining);
    if(end-c.start<minClip)continue;
    picked.push({start:c.start,end,score:Math.round(c.score*1000)/1000,sceneIndex:c.sceneIndex});
    remaining-=end-c.start;
  }
  const beaten=opts.beats?snapToBeats(picked,opts.beats,{tolerance:opts.beatsTolerance}):picked;
  return beaten.sort((a,b)=>a.start-b.start);
}

/**
 * Snap a highlight list's start times to the nearest music beat within `tolerance` seconds
 * (CapCut-style beat-sync: cuts land on the rhythm instead of mid-bar). Each snap keeps the
 * clip end fixed; a snap that would leave the clip shorter than minKeep (0.2s default) is
 * reverted. Beats must be strictly ascending timestamps.
 */
export function snapToBeats(clips:AutoClip[],beats:number[],opts:{tolerance?:number;minKeep?:number}={}):AutoClip[]{
  if(!Array.isArray(clips))throw Error('clips must be an array');
  if(!Array.isArray(beats))throw Error('beats must be an array');
  requireTimes(beats,'beats');
  const tolerance=opts.tolerance??0.4,minKeep=opts.minKeep??0.2;
  if(!isTime(tolerance)||tolerance<=0)throw Error('tolerance must be a positive number');
  if(!isTime(minKeep)||minKeep<=0)throw Error('minKeep must be a positive number');
  return clips.map(c=>{
    let best:number|undefined,bestDist=Infinity;
    for(const beat of beats){
      const dist=Math.abs(beat-c.start);
      if(dist<bestDist){bestDist=dist;best=beat;}
    }
    if(best===undefined||bestDist>tolerance)return c;
    if(c.end-best<minKeep)return c;
    return {...c,start:best};
  });
}

/** Interpolated subject centroid (normalized) at time t; null when no boxes are known. */
function centroidAt(subjects:SubjectFrame[],t:number):{x:number;y:number}|null{
  let prev:SubjectFrame|undefined,next:SubjectFrame|undefined;
  for(const s of subjects){if(s.t<=t)prev=s;if(s.t>=t&&next===undefined)next=s;}
  const point=(f:SubjectFrame)=>{
    let sx=0,sy=0,area=0;
    for(const b of f.boxes){const a=Math.max(b.w*b.h,1e-9);sx+=(b.x+b.w/2)*a;sy+=(b.y+b.h/2)*a;area+=a;}
    return {x:sx/area,y:sy/area};
  };
  if(!prev&&!next)return null;
  if(!next||prev&&next&&prev.t===next.t||!prev)return point((prev??next)!);
  const p=point(prev),n=point(next),f=(t-prev.t)/(next.t-prev.t);
  return {x:p.x+(n.x-p.x)*f,y:p.y+(n.y-p.y)*f};
}

/**
 * Crop rectangles that fit `aspect` (target width/height, e.g. 9/16) into a `width`x`height`
 * frame while following subject boxes. Without subjects the crop stays centered. Windows
 * change only at subject timestamps, so the output is a small keyframe list — unless
 * `maxPan` (max crop-origin speed as a fraction of frame-per-second) is set, which adds
 * intermediate windows so the pan never outruns the subject tracking.
 */
export function computeReframe(input:{width:number;height:number;aspect:number;subjects?:SubjectFrame[];start?:number;end?:number;maxPan?:number}):ReframeWindow[]{
  const {width,height,aspect}=input;
  if(!isTime(width)||!isTime(height)||width<1||height<1)throw Error('reframe: width/height must be positive integers');
  if(!isTime(aspect)||aspect<=0)throw Error('reframe: aspect must be a positive number (width/height)');
  const subjects=input.subjects??[];
  requireTimes(subjects.map(s=>s.t),'subjects');
  for(const s of subjects)for(const b of s.boxes){
    if(![b.x,b.y,b.w,b.h].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw Error('subjects: box values must be within 0..1');
    if(b.w<=0||b.h<=0)throw Error('subjects: box w/h must be positive');
    if(b.x+b.w>1.0001||b.y+b.h>1.0001)throw Error('subjects: box must fit inside the frame');
  }
  const start=input.start??(subjects.length?subjects[0]!.t:0);
  const end=input.end??(subjects.length?Math.max(subjects.at(-1)!.t,start+1):start+1);
  if(end<=start)throw Error('reframe: end must be after start');
  const cropWidth=width/height>aspect?Math.max(1,Math.floor(height*aspect)):width;
  const cropHeight=width/height>aspect?height:Math.max(1,Math.floor(width/aspect));
  const rect=(t:number):CropRect=>{
    const c=centroidAt(subjects,t)??{x:0.5,y:0.5};
    return {
      x:Math.min(Math.max(Math.round(c.x*width-cropWidth/2),0),width-cropWidth),
      y:Math.min(Math.max(Math.round(c.y*height-cropHeight/2),0),height-cropHeight),
      width:cropWidth,height:cropHeight,
    };
  };
  const stops=[...new Set([start,...subjects.map(s=>s.t).filter(t=>t>start&&t<end),end])].sort((a,b)=>a-b);
  const maxPan=input.maxPan;
  const windows:ReframeWindow[]=[];
  if(maxPan===undefined){
    for(let i=0;i<stops.length-1;i++){
      const s=stops[i]!,e=stops[i+1]!,crop=rect((s+e)/2);
      const prev=windows.at(-1);
      if(prev&&prev.crop.x===crop.x&&prev.crop.y===crop.y&&prev.end>=s-1e-9)prev.end=e;
      else windows.push({start:s,end:e,crop});
    }
    return windows;
  }
  if(!isTime(maxPan)||maxPan<=0)throw Error('reframe: maxPan must be a positive number');
  for(let i=0;i<stops.length-1;i++){
    const s=stops[i]!,e=stops[i+1]!,dt=e-s;
    const a=rect(s),b=rect(e);
    const steps=Math.max(1,Math.ceil(Math.max(Math.abs(b.x-a.x)/(maxPan*width*dt+1e-9),Math.abs(b.y-a.y)/(maxPan*height*dt+1e-9))));
    for(let j=0;j<steps;j++){
      const t0=s+dt*(j/steps),t1=j===steps-1?e:s+dt*((j+1)/steps),crop=rect((t0+t1)/2);
      const prev=windows.at(-1);
      if(prev&&prev.crop.x===crop.x&&prev.crop.y===crop.y&&prev.end>=t0-1e-9)prev.end=t1;
      else windows.push({start:t0,end:t1,crop});
    }
  }
  return windows;
}

/** Fit `text` into lines of at most maxChars: word wrap, hard-splitting any oversized word. */
export function wrapCaptionText(text:string,maxChars:number):string[]{
  if(maxChars<1||!Number.isFinite(maxChars))throw Error('maxChars must be a positive number');
  const words=text.trim().split(/\s+/).filter(Boolean),lines:string[]=[];
  let current='';
  for(const word of words){
    if(current&&(current.length+1+word.length)>maxChars){lines.push(current);current=word;}
    else current=current?current+' '+word:word;
    while(current.length>maxChars){lines.push(current.slice(0,maxChars));current=current.slice(maxChars);}
  }
  if(current)lines.push(current);
  return lines;
}

/**
 * Caption cue list from transcript segments: cues respect maxChars (word-wrapped lines)
 * and maxSeconds (durations split proportionally between wrapped lines); overlapping or
 * out-of-order segments are clamped forward so cue times stay monotonic.
 */
export function buildCaptions(segments:TranscriptSegment[],opts:{maxChars?:number;maxSeconds?:number}={}):CaptionCue[]{
  const maxChars=opts.maxChars??42,maxSeconds=opts.maxSeconds??5;
  if(!Number.isFinite(maxChars)||maxChars<1)throw Error('maxChars must be a positive number');
  if(!isTime(maxSeconds)||maxSeconds<=0)throw Error('maxSeconds must be a positive number');
  if(!Array.isArray(segments))throw Error('segments must be an array');
  const cues:CaptionCue[]=[];let floor=0;
  for(const s of segments){
    if(!isTime(s.start)||!isTime(s.end)||s.end<=s.start)throw Error('transcript: each segment needs 0 <= start < end');
    const text=s.text?.trim();
    if(!text)continue;
    const start=Math.max(s.start,floor),span=Math.max(Math.min(s.end,start+maxSeconds)-start,0.2);
    const lines=wrapCaptionText(text,maxChars),totalChars=lines.reduce((sum,l)=>sum+l.length,0);
    let cursor=start;
    for(const line of lines){
      const dur=Math.max(0.2,(line.length/Math.max(totalChars,1))*span);
      const end=cursor+dur;
      cues.push({index:cues.length,start:Math.round(cursor*1000)/1000,end:Math.round(end*1000)/1000,text:line});
      cursor=end;
    }
    floor=Math.max(cursor,s.end);
  }
  return cues;
}

function timeStamp(seconds:number,sep:string){
  const ms=Math.max(0,Math.round(seconds*1000)),h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;
  const pad=(n:number,w:number)=>String(n).padStart(w,'0');
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)}${sep}${pad(ms%1000,3)}`;
}

function validCues(label:string,cues:CaptionCue[]):CaptionCue[]{
  if(!Array.isArray(cues))throw Error(label+': cues must be an array');
  for(const c of cues)if(!isTime(c.start)||!isTime(c.end)||c.end<c.start)throw Error(label+': cues need 0 <= start <= end');
  return cues;
}

/** SubRip (.srt) caption export: numbered blocks with `HH:MM:SS,mmm --> HH:MM:SS,mmm` ranges. */
export function toSrt(cues:CaptionCue[]):string{
  return validCues('toSrt',cues).map(c=>`${c.index+1}\n${timeStamp(c.start,',')} --> ${timeStamp(c.end,',')}\n${c.text}`).join('\n\n')+'\n';
}

/** WebVTT (.vtt) caption export: `WEBVTT` header with `HH:MM:SS.mmm --> HH:MM:SS.mmm` ranges. */
export function toVtt(cues:CaptionCue[]):string{
  return 'WEBVTT\n\n'+validCues('toVtt',cues).map(c=>`${c.index+1}\n${timeStamp(c.start,'.')} --> ${timeStamp(c.end,'.')}\n${c.text}`).join('\n\n')+'\n';
}

/**
 * Rebase cues onto the [start,end) window — the captions companion of a highlight cut: cues
 * overlapping the window stay (clamped to it, times shifted to 0), cues with less than
 * minKeep (default 0.2s) visible are dropped, output re-indexed and monotonic.
 */
export function captionsForRange(cues:CaptionCue[],start:number,end:number,opts:{minKeep?:number}={}):CaptionCue[]{
  validCues('captionsForRange',cues);
  if(!isTime(start)||!isTime(end)||end<=start)throw Error('captionsForRange: end must be after start');
  const minKeep=opts.minKeep??0.2;
  if(!isTime(minKeep)||minKeep<=0)throw Error('captionsForRange: minKeep must be a positive number');
  const out:CaptionCue[]=[];let floor=0;
  for(const c of cues){
    if(Math.min(c.end,end)-Math.max(c.start,start)<minKeep)continue;
    const s=Math.max(c.start,start,floor)-start,e=Math.min(c.end,end)-start;
    if(e-s<=1e-9)continue;
    out.push({index:out.length,start:Math.round(s*1000)/1000,end:Math.round(e*1000)/1000,text:c.text});
    floor=e+start;
  }
  return out;
}

export type AutoEditOptions={
  threshold?:number;adaptive?:boolean;sensitivity?:number;minSceneSeconds?:number;duration?:number;
  targetSeconds?:number;minClipSeconds?:number;maxClipSeconds?:number;beats?:number[];beatsTolerance?:number;
  aspect?:number;width?:number;height?:number;maxPan?:number;subjects?:SubjectFrame[];transcript?:TranscriptSegment[];language?:string;
  maxChars?:number;maxCueSeconds?:number;
};
export type AutoEditPlan={scenes:Scene[];clips:AutoClip[];reframes:ReframeWindow[];captions:CaptionCue[];warnings:string[]};

/** Orchestrate every lane through the injected probe; unavailable lanes degrade with warnings. */
export async function planAutoEdit(videoPath:string,opts:AutoEditOptions,probe:MediaProbe):Promise<AutoEditPlan>{
  if(!videoPath)throw Error('video path is required');
  const warnings:string[]=[];
  const diffs=probe.frameDiffs?await probe.frameDiffs(videoPath):[];
  if(!probe.frameDiffs)warnings.push('frame-diff probe unavailable: treating the video as one scene');
  const energy=probe.audioEnergy?await probe.audioEnergy(videoPath):[];
  if(!probe.audioEnergy)warnings.push('audio-energy probe unavailable: ranking scenes by visual peaks only');
  const duration=opts.duration??diffs.at(-1)?.t??0;
  if(duration<=0){warnings.push('video duration unknown: returning an empty plan');return {scenes:[],clips:[],reframes:[],captions:[],warnings};}
  const threshold=opts.threshold??(opts.adaptive?adaptiveThreshold(diffs,{sensitivity:opts.sensitivity}):undefined);
  const scenes=diffs.length?detectScenes(diffs,{threshold,minSceneSeconds:opts.minSceneSeconds,duration}):[{index:0,start:0,end:duration,peak:0}];
  const clips=pickHighlights(scenes,energy,{targetSeconds:opts.targetSeconds??Math.min(30,duration),minClipSeconds:opts.minClipSeconds,maxClipSeconds:opts.maxClipSeconds,beats:opts.beats,beatsTolerance:opts.beatsTolerance});
  const subjects=opts.subjects??(probe.subjects?await probe.subjects(videoPath):[]);
  let reframes:ReframeWindow[]=[];
  if(opts.aspect){
    if(!subjects.length)warnings.push('no subject boxes: reframing with centered crops');
    reframes=computeReframe({width:opts.width??1920,height:opts.height??1080,aspect:opts.aspect,subjects,start:0,end:duration,maxPan:opts.maxPan});
  }
  const transcript=opts.transcript??(probe.transcribe?await probe.transcribe(videoPath,{language:opts.language}):undefined);
  if(!transcript)warnings.push('no transcript: captions skipped');
  const captions=transcript?buildCaptions(transcript,{maxChars:opts.maxChars,maxSeconds:opts.maxCueSeconds}):[];
  return {scenes,clips,reframes,captions,warnings};
}

/** Parse ffmpeg `metadata=print` output (pts_time + lavfi.scene_score pairs) into frame diffs. */
export function parseSceneLog(text:string):FrameDiff[]{
  const diffs:FrameDiff[]=[];let pendingTime:number|undefined;
  for(const line of text.split(/\r?\n/)){
    const time=/pts_time:([0-9.]+)/.exec(line);
    if(time){pendingTime=Number(time[1]);continue;}
    const score=/lavfi\.scene_score=([0-9.eE+-]+)/.exec(line);
    if(score&&pendingTime!==undefined){diffs.push({t:pendingTime,score:Math.min(1,Number(score[1]))});pendingTime=undefined;}
  }
  return diffs;
}

/** Parse ffmpeg ebur128 log lines ("M: -xx.x LUFS ... t:NNNN") into [0,1] windowed energy samples. */
export function parseLoudnessLog(text:string):EnergySample[]{
  const readings:[number,number][]=[];
  for(const line of text.split(/\r?\n/)){
    const time=/\bt:\s*(\d+(?:\.\d+)?)/.exec(line),momentary=/\bM:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if(time&&momentary)readings.push([Number(time[1])/1000,Math.min(1,Math.max(0,(Number(momentary[1])+60)/60))]);
  }
  const samples:EnergySample[]=[];
  for(let i=0;i<readings.length-1;i++)samples.push({start:readings[i]![0],end:readings[i+1]![0],energy:readings[i]![1]});
  return samples;
}
