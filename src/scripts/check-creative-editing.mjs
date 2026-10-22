import assert from 'node:assert/strict';
import {newTimeline,newClip,validateTimeline,timelineDuration} from '../../ui/creative-timeline-model.js';
import {animatedValue,setKeyframe} from '../../ui/creative-keyframes.js';
import {frameTime,timecode,parseTimecode,trimAtCursor,rippleDelete,snapClipStart} from '../../ui/creative-editing.js';
for(const fps of [24,30,60])for(const frame of [0,1,fps-1,fps,12345])assert.ok(Math.abs(parseTimecode(timecode(frame/fps,fps),fps)-frame/fps)<1e-8);
assert.throws(()=>parseTimecode('00:00:01:30',30));assert.equal(frameTime(.11,30),3/30);
for(const fps of [24,30,60]){const project=newTimeline();project.fps=fps;const one=newClip(project.tracks[0],null,0);one.duration=1/fps;project.clips=[one];validateTimeline(project);assert.equal(timelineDuration(project),1/fps);}
const p=newTimeline(),c=newClip(p.tracks[0],null,0);c.duration=4;c.speed=2;p.clips=[c];setKeyframe(c,'x',0,0,'smooth');setKeyframe(c,'x',4,1);const original=structuredClone(c);trimAtCursor(p,c.id,1,'start');assert.equal(c.start,1);assert.equal(c.in,2);assert.equal(c.duration,3);for(let t=1;t<4;t+=.2)assert.equal(animatedValue(c,'x',t),animatedValue(original,'x',t));trimAtCursor(p,c.id,3,'end');assert.equal(c.duration,2);validateTimeline(p);assert.throws(()=>trimAtCursor(p,c.id,3,'start'));
const next={...newClip(p.tracks[0],null,4),duration:1},other={...newClip(p.tracks[1],null,4),duration:1};p.clips.push(next,other);rippleDelete(p,c.id);assert.equal(next.start,2);assert.equal(other.start,4,'ripple affects selected track only');
const overlap={...newClip(p.tracks[0],null,2.5),duration:1};p.clips.push(overlap);const before=structuredClone(p);assert.throws(()=>rippleDelete(p,next.id));assert.deepEqual(p,before,'overlap rejection is atomic');assert.equal(snapClipStart(p,overlap,3.04,0,100),3);
console.log('PASS frame timecode, source-aware trim, animation preservation, ripple delete scope/overlap and edge snapping');
