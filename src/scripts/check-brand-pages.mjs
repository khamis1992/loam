import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const origin='http://127.0.0.1:3939';
const ui=path.resolve('ui');
const out=path.resolve('output/verification/brand-pages');
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const routes=['/','/#/services','/#/settings','/#/projects','/#/schedules','/#/tasks',...['ask','build','research','write','data','automate','media'].map(m=>'/#/modes/'+m),...['brain','companions','learning','memory','skills','screen','terminal','integrations','mobile','security','swarm'].map(p=>'/'+p+'.html'),...['mobile','office','creative','security','swarm'].map(p=>'/studios/index.html#'+p)];
const results=[];
try{
 for(const theme of ['dark','light']){
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(t=>{try{localStorage.setItem('loam-theme',t);}catch{}},theme);
 await context.route(origin+'/**',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(req.method()!=='GET'){await route.abort();return;}
  if(url.pathname==='/api/settings'){const r=await route.fetch();const data=await r.json();await route.fulfill({json:{...data,theme}});return;}
  if(!process.env.LOAM_BRAND_INSTALLED && !url.pathname.startsWith('/api/')){
   const file=path.resolve(ui,'.'+(url.pathname==='/'?'/index.html':url.pathname));
   if(file.startsWith(ui+path.sep))try{const body=await fs.readFile(file);const ext=path.extname(file);await route.fulfill({body,contentType:({'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.woff2':'font/woff2'})[ext]||'application/octet-stream'});return;}catch{}
  }
  await route.continue();
 });
 const page=await context.newPage();
 for(const url of routes){
  const errors=[];const handler=e=>errors.push(e.message);page.on('pageerror',handler);
  await page.goto(origin+url);await page.waitForFunction(()=>!!customElements.get('loam-icon'));
  await page.waitForTimeout(450);
  const state=await page.evaluate(()=>({theme:document.documentElement.dataset.theme,bg:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),icons:document.querySelectorAll('svg[data-loam-icon]').length,broken:[...document.querySelectorAll('loam-icon')].filter(e=>!e.querySelector('svg[data-loam-icon]')).length,favicon:document.querySelector('link[rel=icon]')?.getAttribute('href'),stock:[...document.querySelectorAll('button,a.back,.brand-icon,.welcome,.empty-symbol')].filter(e=>e.getClientRects().length&&/[✧✦◈◇⬡↗↻✓✗⚙🔍📁📄]/u.test(e.textContent)).map(e=>e.textContent.slice(0,100))}));
  assert.equal(state.theme,theme,url);assert.equal(state.bg,theme==='dark'?'#101914':'#f1f4ed',url);assert.equal(state.broken,0,url);assert.equal(state.favicon,'/assets/loam-symbol.svg',url);assert.deepEqual(state.stock,[],url);assert.deepEqual(errors,[],url);
  const name=(url==='/'?'home':url.replace(/[^a-z0-9]+/gi,'-'))+'-'+theme;
  await page.screenshot({path:path.join(out,name+'.png')});
  results.push({url,theme,icons:state.icons});page.off('pageerror',handler);
 }
 // A theme change in a separate shell propagates to an already-open studio.
 await page.goto(origin+'/mobile.html');const shell=await context.newPage();await shell.goto(origin+'/');await shell.evaluate(t=>localStorage.setItem('loam-theme',t),theme==='dark'?'light':'dark');await page.waitForFunction(t=>document.documentElement.dataset.theme===t,theme==='dark'?'light':'dark');
 await context.close();
 }
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log(`PASS ${results.length} page/theme views, original icons, favicon, palette, no page errors, cross-page theme sync.`);
}finally{await browser.close();}
