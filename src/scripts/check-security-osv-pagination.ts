import assert from 'node:assert/strict';
import {queryAdvisories,type DependencyInventory} from '../security/dependencies.js';
const fresh=():DependencyInventory=>({packages:[{name:'a',version:'1.0.0',dev:false},{name:'b',version:'2.0.0',dev:false}],findings:[],warnings:[]});
const inventory=fresh();let calls=0;
await queryAdvisories(inventory,new AbortController().signal,(async(url,options)=>{
  assert.equal(url,'https://api.osv.dev/v1/querybatch');assert.equal(options!.redirect,'error');
  const q=JSON.parse(String(options!.body)).queries;calls++;
  if(calls===1){assert.equal(q.length,2);assert.ok(q.every((x:any)=>!x.page_token));return new Response(JSON.stringify({results:[{vulns:[{id:'A-1'}],next_page_token:'a-next'},{vulns:[{id:'B-1'}]}]}));}
  assert.deepEqual(q,[{package:{name:'a',ecosystem:'npm'},version:'1.0.0',page_token:'a-next'}]);
  return new Response(JSON.stringify({results:[{vulns:[{id:'A-1'},{id:'A-2'}]}]}));
}) as typeof fetch);
assert.equal(calls,2);assert.equal(inventory.advisories!.complete,true);assert.equal(inventory.advisories!.queried,2);assert.equal(inventory.advisories!.completed,2);
assert.deepEqual(inventory.advisories!.matches.map(m=>m.ids),[['A-1','A-2'],['B-1']]);assert.equal(inventory.findings.length,2);
for(const mode of ['repeat','limit','outage']){
  const x=fresh();x.packages.length=1;let n=0;
  await queryAdvisories(x,new AbortController().signal,(async()=>{n++;if(mode==='outage'&&n===2)return new Response('',{status:503});return new Response(JSON.stringify({results:[{vulns:[{id:'A-'+n}],next_page_token:mode==='repeat'?'same':'next-'+n}]}));}) as typeof fetch);
  assert.equal(x.advisories!.complete,false);assert.equal(n,mode==='limit'?10:2);assert.equal(x.advisories!.queried,1);assert.equal(x.advisories!.completed,0);
  assert.ok(x.findings.some(f=>f.verdict==='finding'));assert.ok(x.findings.some(f=>f.verdict==='error'));
}
const cancelled=fresh();cancelled.packages.length=1;const controller=new AbortController();let n=0;
await assert.rejects(queryAdvisories(cancelled,controller.signal,(async()=>{if(++n===2){controller.abort();throw controller.signal.reason;}return new Response(JSON.stringify({results:[{vulns:[{id:'A-1'}],next_page_token:'next'}]}));}) as typeof fetch));
assert.ok(cancelled.findings.some(f=>f.verdict==='finding'));assert.equal(cancelled.advisories!.complete,false);
const budget=fresh();budget.packages=Array.from({length:1000},(_,i)=>({name:'p'+i,version:'1.0.0',dev:false}));let attempts=0;
await queryAdvisories(budget,new AbortController().signal,(async(_url,options)=>{
  attempts++;const queries=JSON.parse(String(options!.body)).queries;
  return new Response(JSON.stringify({results:queries.map((q:any)=>{const page=Number(q.page_token??'0');return page===5?{}:{next_page_token:String(page+1)};})}));
}) as typeof fetch);
assert.equal(attempts,50);assert.equal(budget.advisories!.requests,50);assert.equal(budget.advisories!.complete,false);
assert.equal(budget.advisories!.completed,800);assert.equal(budget.advisories!.queried,900);
console.log('PASS OSV pagination: package/token alignment, selective continuation, deduplication, unique counts, repeated tokens, page bound and retained findings on outage/cancellation');
