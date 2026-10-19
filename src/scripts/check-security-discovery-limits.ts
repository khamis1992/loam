import assert from 'node:assert/strict';
import {discover} from '../security/discovery.js';
import {normalizeScope} from '../security/scope.js';
const base='http://127.0.0.1:12345/';
async function crawl(bodies:Record<string,string>,options:Record<string,unknown>){
  const requested:string[]=[];
  const result=await discover(normalizeScope(base,{delayMs:0,...options}),async url=>{requested.push(url);return {ok:true,status:200,headers:{'content-type':'text/html'},setCookie:[],body:bodies[new URL(url).pathname]??''};},[],new AbortController().signal,()=>{});
  return {result,requested};
}
const link=(p:string)=>`<a href="${p}">link</a>`;
const depth=await crawl({'/':link('/child')+link('/child')+link('/')+link('https://outside.invalid/')},{maxDepth:0});
assert.equal(depth.result.truncated,true);assert.deepEqual(depth.result.limits,{depth:1,pages:0,queue:0});assert.deepEqual(depth.requested,[base]);
assert.deepEqual(depth.result.unvisited,[{url:base+'child',reason:'depth'}]);
const exact=await crawl({'/':link('/child'),'/child':link('/')},{maxDepth:1,maxPages:2});assert.equal(exact.result.truncated,false);
const pages=await crawl({'/':link('/a')+link('/b')},{maxPages:1});assert.deepEqual(pages.result.limits,{depth:0,pages:2,queue:0});
const duplicate=await crawl({'/':link('/a').repeat(100)+link('/b')},{maxPages:3});assert.deepEqual(duplicate.requested,[base,base+'a',base+'b']);assert.equal(duplicate.result.truncated,false);
const capacity=await crawl({'/':Array.from({length:12},(_,i)=>link('/'+i)).join('')},{maxPages:1});assert.deepEqual(capacity.result.limits,{depth:0,pages:10,queue:2});
const alternate=await crawl({'/':link('/a'),'/a':link('/b')},{maxDepth:0,seeds:[base+'a',base+'b']});assert.equal(alternate.result.truncated,false,'A deferred URL later visited as a seed must not remain missing');
const excluded=await crawl({'/':link('/private')},{maxDepth:0,exclusions:['/private']});assert.equal(excluded.result.truncated,false);assert.equal(excluded.result.skipped,1);
const sample=await crawl({'/':Array.from({length:150},(_,i)=>link('/'+i)).join('')},{maxDepth:0});assert.equal(sample.result.unvisited!.length,100);assert.equal(sample.result.limits!.depth,150);
console.log('PASS discovery: depth/page/queue limits, deduplication, cycles, alternate seeds, exclusions and bounded URL samples');
