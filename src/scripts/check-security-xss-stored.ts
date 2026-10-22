import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-xss-stored-'));
let fixed=false;
const escape=(v:string)=>v.replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));
type Comment={text:string};
const boards:{raw:Comment[];safe:Comment[];hidden:Comment[]}={raw:[],safe:[],hidden:[]};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  let raw='';for await(const part of req)raw+=part;
  const htmlPage=(title:string,body:string)=>`<!doctype html><html><head><title>fixture</title></head><body><h1>${title}</h1>${body}</body></html>`;
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  const store=(board:'raw'|'safe'|'hidden')=>{let text='';try{text=JSON.parse(raw).text??'';}catch{}boards[board].push({text});return json(201,{stored:boards[board].length});};
  const render=(board:'raw'|'safe'|'hidden',esc:boolean)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(htmlPage('Board',boards[board].map(c=>'<article>'+(esc?escape(c.text):c.text)+'</article>').join('')));return;};
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end(htmlPage('Home',''));return;}
  if(url.pathname==='/api/comments'&&req.method==='POST')return store('raw');
  if(url.pathname==='/board'&&req.method==='GET')return render('raw',fixed);
  if(url.pathname==='/api/notes'&&req.method==='POST')return store('safe');
  if(url.pathname==='/notes'&&req.method==='GET')return render('safe',true);
  if(url.pathname==='/api/private-notes'&&req.method==='POST')return store('hidden');
  if(url.pathname==='/hidden'&&req.method==='GET'){res.setHeader('content-type','text/html').end(htmlPage('Hidden',''));return;}
  if(url.pathname==='/api/failing'&&req.method==='POST')return json(500,{error:'unavailable'});
  if(url.pathname==='/failing-view'&&req.method==='GET'){res.writeHead(500).end('unavailable');return;}
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+90000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('stored xss assessment timed out');};
const browser={enabled:true,screenshots:false,maxPages:1,settleMs:250,networkIdleTimeoutMs:2000,postPaths:['/api/comments','/api/notes','/api/private-notes','/api/failing'],xssStored:[
  {id:'rawBoard',postPath:'/api/comments',bodyRef:'commentBody',field:'text',viewPath:'/board'},
  {id:'escapedBoard',postPath:'/api/notes',bodyRef:'noteBody',field:'text',viewPath:'/notes'},
  {id:'notRendered',postPath:'/api/private-notes',bodyRef:'privateBody',field:'text',viewPath:'/hidden'},
  {id:'brokenStorage',postPath:'/api/failing',bodyRef:'failingBody',field:'text',viewPath:'/board'},
]};
const input={target,authorized:true,checks:['server_banner'],scope:{delayMs:0,maxRequests:300},browser,browserSecrets:{commentBody:JSON.stringify({text:'fixture-comment-body',by:'fixture-author'}),noteBody:JSON.stringify({text:'fixture-note-body'}),privateBody:JSON.stringify({text:'fixture-private-body'}),failingBody:JSON.stringify({text:'fixture-failing-body'})}};
try{
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,enabled:false}}),/Stored XSS checks require the browser engine/);
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,xssStored:[{...browser.xssStored[0]!,postPath:'/api/unknown'}]}}),/allowlisted in postPaths/);
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,xssStored:[{...browser.xssStored[0]!,viewPath:'/board?x=1'}]}}),/exact view path/);
  assert.throws(()=>startAssessment(root,{...input,browserSecrets:{}}),/fresh browser input: commentBody|Stored XSS body/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({proofs:first.browser?.proofs.filter(p=>p.kind==='xss_stored').map(p=>[p.target,p.outcome,p.summary]),findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  const proofs=(first.browser?.proofs??[]).filter(p=>p.kind==='xss_stored');
  assert.equal(proofs.length,4,'four stored XSS proofs');
  const rawBoard=proofs.find(p=>p.target.endsWith('/board')&&p.observations.executed!==undefined)!;
  const escaped=proofs.find(p=>p.target.endsWith('/notes'))!;
  const hidden=proofs.find(p=>p.target.endsWith('/hidden'))!;
  const failing=proofs.find(p=>p.target.endsWith('/board')&&p.observations.storageStatus===500)!;
  assert.ok(rawBoard&&escaped&&hidden&&failing,JSON.stringify(proofs.map(p=>[p.target,p.observations.storageStatus])));
  assert.equal(rawBoard.outcome,'observed',JSON.stringify(rawBoard));
  assert.equal(rawBoard.observations.executed,true);
  assert.equal(rawBoard.observations.reflected,true);
  assert.equal(rawBoard.observations.baselineClean,true);
  assert.equal(rawBoard.observations.storageStatus,201);
  assert.equal(escaped.outcome,'not_observed',JSON.stringify(escaped));
  assert.equal(escaped.observations.reflected,true);
  assert.equal(escaped.observations.executed,false);
  assert.equal(hidden.outcome,'not_observed',JSON.stringify(hidden));
  assert.equal(hidden.observations.reflected,false);
  assert.equal(failing.outcome,'inconclusive');
  assert.match(String(failing.summary),/Storage submission was not accepted/);
  const finding=first.findings.find(f=>f.check.startsWith('xss_stored_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.equal(finding.severity,'high');
  assert.ok(finding.target.includes('/board'));
  assert.ok(!JSON.stringify(first).includes('onerror='),'the canary payload must never be recorded');
  assert.ok(!JSON.stringify(first).includes('fixture-comment-body'),'the stored body value must be redacted');
  const module=first.diagnostics?.modules.find(m=>m.id==='xss_stored');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,4);assert.equal(module?.conclusive,3);assert.equal(module?.inconclusive,1);
  assert.ok(first.covered.some(k=>k.includes('/notes')&&k.includes('xss_stored_')));
  fixed=true;boards.raw.length=0;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,browserSecrets:input.browserSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  const secondRaw=(second.browser?.proofs??[]).filter(p=>p.kind==='xss_stored').find(p=>p.target.endsWith('/board'))!;
  assert.equal(secondRaw.outcome,'not_observed','an escaped render must not execute after repair');
  console.log('PASS stored xss: canary stored through an authorized POST executed in a fresh viewer profile with a clean baseline control, escaped render neutralized, unrendered storage reported as coverage, rejected storage inconclusive, payload and body never recorded, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
