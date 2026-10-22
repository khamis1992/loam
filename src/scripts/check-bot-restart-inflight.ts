import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BackendSandbox} from '../agent/backendSandbox.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-restart-inflight-'));
fs.writeFileSync(path.join(root,'server.mjs'),`import http from 'node:http';import fs from 'node:fs';
http.createServer((q,r)=>{
 r.setHeader('content-type','application/json');
 if(q.url==='/slow'){fs.writeFileSync('/tmp/pending','1');setTimeout(()=>r.end(JSON.stringify({pid:process.pid,done:true})),1500);return;}
 if(q.url==='/pending'){r.end(JSON.stringify({pending:fs.existsSync('/tmp/pending')}));return;}
 r.end(JSON.stringify({pid:process.pid}));
}).listen(3000,'127.0.0.1');`);
const sandbox=await BackendSandbox.start(root,'server.mjs');
const evidence:Record<string,any>={at:new Date().toISOString(),scope:'Actual Docker test of restart while a request is provably in flight',pass:false};
try{
 const slow=Promise.allSettled([sandbox.request('/slow')]);
 let pending=false;
 for(let i=0;i<20;i++){
  const r=await sandbox.request('/pending');pending=JSON.parse(Buffer.from(r.body,'base64').toString()).pending;
  if(pending)break;await new Promise(resolve=>setTimeout(resolve,25));
 }
 assert.equal(pending,true,'Server must have received the slow request before restarting');
 const restarting=sandbox.restart();
 const during=sandbox.request('/');
 const cancelled=new AbortController();
 const cancelledRequest=sandbox.request('/never-sent','GET',{},'',cancelled.signal);
 cancelled.abort(new Error('Cancel queued request'));
 await assert.rejects(cancelledRequest,/Cancel queued request/);
 await assert.rejects(sandbox.restart(),/already in progress/);
 const restart=await restarting;const result=(await slow)[0]!;
 const after=await during;
 assert.equal(after.status,200);assert.equal(JSON.parse(Buffer.from(after.body,'base64').toString()).pid,restart.currentPid,'Requests arriving during restart wait for the replacement process');
 evidence.restart=restart;evidence.request=result.status==='fulfilled'?{status:result.status,response:result.value}:{status:result.status,error:String(result.reason)};
 assert.equal(result.status,'fulfilled','A controlled restart must drain existing requests before killing their server');
 if(result.status==='fulfilled'){assert.equal(result.value.status,200);assert.equal(JSON.parse(Buffer.from(result.value.body,'base64').toString()).pid,restart.previousPid);}
 evidence.queuedRequest=JSON.parse(Buffer.from(after.body,'base64').toString());evidence.queuedCancellation=true;evidence.concurrentRestartRejected=true;
 evidence.pass=true;console.log('PASS controlled restart drains in-flight request; new requests wait for replacement; queued cancellation and concurrent-restart rejection');
}catch(error){evidence.error=String(error);process.exitCode=1;console.error(String(error));}
finally{await sandbox.close();const output='docs/evidence/bot-restart-inflight-'+Date.now()+'.json';fs.writeFileSync(output,JSON.stringify(evidence,null,2));console.log(output);}
