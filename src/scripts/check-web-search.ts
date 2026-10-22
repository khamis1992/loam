import assert from 'node:assert/strict';
import {parseSearchPage,webTools} from '../tools/web.js';
import {loadConfig} from '../config.js';
const xml='<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example &amp; source</a><a href="javascript:bad" class="result__a">invalid</a>';
assert.deepEqual(parseSearchPage(xml,10),[{title:'Example & source',url:'https://example.com/page'}]);
assert.throws(()=>parseSearchPage('<html>captcha</html>',5));assert.deepEqual(parseSearchPage('<div class="no-results">No results found</div>',5),[]);
const cfg=loadConfig(),ctx={cfg,workspace:cfg.workspace,emit:()=>{}};const tool=webTools.find(t=>t.name==='web_search')!;
const original=globalThis.fetch;let calls=0;
try{
 globalThis.fetch=async(input)=>{calls++;assert.match(String(input),/q=Loam/);return new Response(xml,{headers:{'content-type':'text/xml'}});};
 cfg.policy.networkEnabled=false;assert.equal((await tool.run({query:'Loam'},ctx)).ok,false);assert.equal(calls,0);
 cfg.policy.networkEnabled=true;assert.equal((await tool.run({query:''},ctx)).ok,false);assert.equal(calls,0);
 const result=await tool.run({query:'Loam',limit:1},ctx);assert.equal(result.ok,true);assert.equal(JSON.parse(result.content).results.length,1);
 globalThis.fetch=async()=>new Response('unavailable',{status:503});assert.equal((await tool.run({query:'Loam'},ctx)).ok,false);
 globalThis.fetch=async()=>new Response('<html>captcha</html>');assert.equal((await tool.run({query:'Loam'},ctx)).ok,false);
}finally{globalThis.fetch=original;}
console.log('PASS search: source links, query validation, network policy, provider failure and challenge detection');
