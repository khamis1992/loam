import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-chat-heartbeat-'));
process.env.MANUS_LOCAL_DATA_DIR=path.join(root,'data');
process.env.MANUS_LOCAL_SKILLS_DIR=path.join(root,'skills');
const {loadConfig}=await import('../config.js');
const {startServer}=await import('../server/http.js');
const {OllamaClient}=await import('../ollama.js');
const cfg=loadConfig();cfg.workspace=path.join(root,'workspace');fs.mkdirSync(cfg.workspace);
cfg.server.port=0;cfg.server.host='127.0.0.1';
let release:()=>void=()=>{};let completed=false;
const blocked=new Promise<void>(resolve=>{release=resolve;});
const server=await startServer({cfg,ollama:new OllamaClient('http://127.0.0.1:1'),runTask:async o=>{
 o.emit({type:'step',index:1});await blocked;completed=true;
 return {taskId:o.taskId!,text:'fixture result'};
}});
const address=server.address();assert.ok(address&&typeof address!=='string');
try{
 const body=JSON.stringify({prompt:'heartbeat transport fixture',mode:'build',workMode:'loam'});
 let text='';
 await new Promise<void>((resolve,reject)=>{
  const request=http.request({hostname:'127.0.0.1',port:address.port,path:'/api/chat',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
   assert.equal(res.statusCode,200);
   res.on('data',chunk=>{text+=chunk.toString();if(text.includes(': keepalive\n\n')){clearTimeout(timer);res.destroy();resolve();}});
   res.on('error',reject);
  });
  const timer=setTimeout(()=>{request.destroy();reject(new Error('Silent chat failed to send a heartbeat within 18 seconds'));},18000);
  request.on('error',error=>{clearTimeout(timer);reject(error);});request.end(body);
 });
 assert.equal(completed,false,'Heartbeat must not complete work');
 assert.ok(!text.includes('"type":"done"')&&!text.includes('"type":"assistant_message"'));
 release();await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(completed,true,'Disconnecting the observer must not cancel the running task');
 console.log('PASS actual POST /api/chat emits idle heartbeat without false completion; observer disconnect preserves work');
}finally{release();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
