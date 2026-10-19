import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BrowserFrontier} from '../security/browser-frontier.js';
import {normalizeScope} from '../security/scope.js';
import {startAssessment,readAssessment} from '../security/assessments.js';
import {sarif} from '../security/findings.js';

const base='http://127.0.0.1:12345/';
const make=(settings:Record<string,unknown>={})=>new BrowserFrontier(normalizeScope(base,{delayMs:0,...settings}));
const depth=make({maxDepth:0});depth.next();depth.add([base+'a',base+'a',base,'https://outside.invalid/'],0,false);
assert.deepEqual(depth.snapshot().limits,{depth:1,pages:0,queue:0,interrupted:0});
const dedup=make();dedup.next();dedup.add([...Array(100).fill(base+'a'),base+'b'],0,false);
assert.equal(dedup.next()!.url,base+'a');assert.equal(dedup.next()!.url,base+'b');assert.equal(dedup.snapshot().incomplete,false);
const queue=make();queue.next();queue.add(Array.from({length:150},(_,i)=>base+i),0,false);
assert.deepEqual(queue.snapshot().limits,{depth:0,pages:100,queue:50,interrupted:0});assert.equal(queue.snapshot().unvisited.length,100);
assert.equal(queue.snapshot(true).limits.interrupted,100);
const alternative=make({maxDepth:0,seeds:[base+'a']});alternative.next();alternative.add([base+'a'],0,false);alternative.next();assert.equal(alternative.snapshot().incomplete,false);
const excluded=make({maxDepth:0,exclusions:['/private']});excluded.next();excluded.add([base+'private',base+'?secret=1',base+'#route'],0,false);assert.equal(excluded.snapshot().incomplete,false);
const links=make();links.next();links.add([],0,true);assert.equal(links.snapshot().linkLimitedPages,1);assert.equal(links.snapshot().incomplete,true);

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-browser-discovery-'));
let count=1,duplicate=false;
const server=http.createServer((req,res)=>{
  res.setHeader('content-type','text/html');
  res.end(req.url==='/'?'<div id="ready"></div><script>document.getElementById("ready").innerHTML='+JSON.stringify(Array.from({length:count},(_,i)=>'<a href="/'+(duplicate?'same':i)+'">child</a>').join(''))+'</script>':'<div id="ready">Child</div>');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port+'/';
async function run(maxDepth:number,maxPages:number){
  const initial=startAssessment(root,{target,authorized:true,checks:['server_banner'],scope:{delayMs:0,maxDepth,maxPages},browser:{enabled:true,screenshots:false,maxPages,settleMs:250,readySelector:'#ready'}});
  for(let n=0;n<600;n++){const r=readAssessment(root,initial.id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');
}
try{
  const depthRun=await run(0,2);assert.equal(depthRun.status,'partial');assert.equal(depthRun.browser!.discovery!.limits.depth,1);
  assert.ok(depthRun.findings.some(f=>f.check==='browser_discovery_coverage'&&f.verdict==='error'));
  assert.equal(sarif(depthRun.findings).runs[0]!.invocations[0]!.executionSuccessful,false);
  assert.ok(depthRun.diagnostics!.reasons.some(r=>r.includes('JavaScript')));
  const pages=await run(2,1);assert.equal(pages.browser!.discovery!.limits.pages,1);
  const complete=await run(1,2);assert.equal(complete.browser!.discovery!.incomplete,false);assert.equal(complete.browser!.pages.length,2);
  count=101;duplicate=true;const repeated=await run(1,2);assert.equal(repeated.browser!.discovery!.incomplete,false);assert.equal(repeated.browser!.pages.length,2);
  count=501;duplicate=false;const bounded=await run(0,1);assert.equal(bounded.browser!.discovery!.linkLimitedPages,1);assert.equal(bounded.browser!.discovery!.limits.depth,500);assert.equal(bounded.browser!.discovery!.unvisited.length,100);
  console.log('PASS: JavaScript-created links, depth/page/queue limits, duplicate crowding, alternate seeds, exclusions, interrupted queue, 500-link bound, diagnostics and SARIF');
}finally{server.closeAllConnections();server.close();fs.rmSync(root,{recursive:true,force:true});}
