import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
const out='output/companions-voice';await fs.mkdir(out,{recursive:true});
const agent={id:'voice1',name:'رفيق الصوت',mode:'build',workMode:'loam'};
const record:{chat:string[];voiceTurns:any[];cancelled:boolean}={chat:[],voiceTurns:[],cancelled:false};
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url!,'http://localhost');
  const json=(value:any,code=200)=>{res.statusCode=code;res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
  if(url.pathname==='/api/chat'&&req.method==='POST'){
   let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);record.chat.push(body.prompt);
   res.setHeader('content-type','text/event-stream');
   const send=(ev:any)=>res.write(`data: ${JSON.stringify(ev)}\n\n`);
   send({type:'task',taskId:'tv1'});
   send({type:'assistant_token',text:'أهلاً بك يا صاحبي. '});
   send({type:'assistant_token',text:'كيف أخدمك اليوم؟'});
   send({type:'assistant_message',text:'أهلاً بك يا صاحبي. كيف أخدمك اليوم؟'});
   send({type:'done'});
   res.end();return;
  }
  if(url.pathname==='/api/agents/voice1/voice'&&req.method==='POST'){
   let raw='';for await(const c of req)raw+=c;record.voiceTurns.push(JSON.parse(raw));json({ok:true});return;
  }
  if(url.pathname==='/api/work-modes')return json({modes:[{id:'loam',labelAr:'تنفيذ داخل Loam'}]});
  if(url.pathname==='/api/modes')return json({modes:[]});
  if(url.pathname==='/api/settings')return json({settings:{}});
  if(url.pathname==='/api/tools')return json({tools:[]});
  if(url.pathname==='/api/approvals')return json({approvals:[]});
  if(url.pathname==='/api/agents')return json({agents:[agent]});
  if(url.pathname==='/api/models')return json({models:[]});
  if(url.pathname==='/api/tasks')return json({tasks:[]});
  if(url.pathname==='/api/agents/voice1')return json({agent,capabilities:{services:[],allow:[]}});
  if(url.pathname==='/api/agents/voice1/memory')return json({entries:[]});
  if(url.pathname==='/api/agents/voice1/usage')return json({usage:{runs:0}});
  if(url.pathname==='/api/agents/voice1/secrets')return json({secrets:[]});
  if(url.pathname==='/')return fs.readFile('ui/companions.html').then(b=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(b);});
  if(/\.(css|js|svg|png|ico|html|map|woff2?)$/i.test(url.pathname)||url.pathname.startsWith('/assets')){
   const file='ui'+url.pathname;try{const b=await fs.readFile(file);res.setHeader('content-type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(b);}catch{res.statusCode=404;res.end();}
   return;
  }
  res.statusCode=404;res.setHeader('content-type','text/plain');res.end('not found');
 }catch(error:any){res.statusCode=500;res.end(String(error));}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1360,height:940}});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 // Fake speech engines injected into the HTML response itself — no function serialization involved.
 const speechMock=`<script>
  (() => {
   const spoken = []; let started = 0; let cancels = 0; let speaking = false; let current = null;
   class Utterance { constructor(text) { this.text = text; } }
   const synthMock = {
    getVoices: () => [{ name: 'ar-mock', lang: 'ar-SA' }],
    get speaking() { return speaking; },
    speak(u) { speaking = true; current = u; spoken.push(String(u.text)); if (u.onstart) u.onstart(); setTimeout(() => { if (current === u) { speaking = false; current = null; if (u.onend) u.onend(); } }, 4); },
    cancel() { if (speaking) cancels++; speaking = false; if (current && current.onend) current.onend(); current = null; },
   };
   // Plain assignment cannot replace the native engine; defineProperty can.
   Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true });
   Object.defineProperty(window, 'speechSynthesis', { value: synthMock, configurable: true });
   class FakeSR {
    start() { started++; FakeSR.instance = this; }
    stop() { /* controlled by the test */ }
   }
   window.SpeechRecognition = FakeSR;
   window.__voice = {
    spoken,
    starts: () => started,
    cancels: () => cancels,
    setSpeaking: (v) => { speaking = v; },
    say: (text) => { const rec = FakeSR.instance; if (!rec || !rec.onresult) throw Error('no active recognition'); rec.onresult({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal: true, length: 1 }] }); },
    interim: (text) => { const rec = FakeSR.instance; if (!rec || !rec.onresult) throw Error('no active recognition'); rec.onresult({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal: false, length: 1 }] }); },
    endRec: () => { if (FakeSR.instance && FakeSR.instance.onend) FakeSR.instance.onend(); },
   };
  })();
 </script>`;
 await page.route('**/', async route => {
  const response=await route.fetch();
  const body=(await response.text()).replace('</head>',speechMock+'</head>');
  await route.fulfill({response,body,headers:{...response.headers(),'content-type':'text/html; charset=utf-8'}});
 });
 await page.goto('http://127.0.0.1:'+(server.address() as any).port);
 await page.waitForFunction(`document.querySelector('.rk-agent, [data-agent], #rkAgentList *')!==null||document.body.innerText.includes('رفيق الصوت')`,null,{timeout:15000}).catch(()=>{});
 await page.locator('.rk-bot', { hasText: 'رفيق الصوت' }).first().click();
 await page.waitForTimeout(500);
 // Start the live voice session: recognition starts once and the bar reports open state.
 await page.click('#rkVoiceMicBtn');
 await page.waitForFunction(`document.querySelector('#rkVoiceBar') && document.querySelector('#rkVoiceBar').getAttribute('data-on')==='1'`);
 assert.equal(await page.evaluate("window.__voice.starts()"),1,'session starts the microphone exactly once');
 assert.match((await page.locator('#rkVoiceStatus').textContent()) ?? '',/محادثة صوتية/);
 // A spoken final transcript becomes a chat prompt; streamed tokens are spoken sentence by sentence.
 await page.evaluate("window.__voice.setSpeaking(false)");
 await page.evaluate(`window.__voice.say("مرحبا الرفيق")`);
 await page.waitForFunction(`window.__voice.spoken.join(' ').includes('كيف أخدمك اليوم؟')`,null,{timeout:10000});
 assert.deepEqual(record.chat,['مرحبا الرفيق']);
 const spokenText=(await page.evaluate(`window.__voice.spoken.join(" | ")`)) as string;
 assert.ok(spokenText.includes('أهلاً بك يا صاحبي.'),'first sentence is spoken on its own: '+spokenText);
 assert.ok(spokenText.includes('كيف أخدمك اليوم؟'),'second sentence is spoken: '+spokenText);
 assert.ok(record.voiceTurns.some(t=>t.speaker==='user'&&t.text==='مرحبا الرفيق'),'user turn recorded in the transcript');
 assert.ok(record.voiceTurns.some(t=>t.speaker==='companion'),'companion reply recorded in the transcript');
 // Any speech from the user interrupts the companion mid-sentence (barge-in).
 await page.evaluate("window.__voice.setSpeaking(true)");
 await page.evaluate(`window.__voice.interim("كفى")`);
 assert.ok(Number(await page.evaluate("window.__voice.cancels()"))>=1,'barge-in cancels synthesis immediately');
 assert.match((await page.locator('#rkVoiceStatus').textContent()) ?? '',/تمت المقاطعة|… كفى/,'barge-in visibly interrupts or echoes the user speech');
 // Recognition auto-restarts when the engine drops while the session stays open.
 await page.evaluate("window.__voice.endRec()");
 await page.waitForFunction(`window.__voice.starts()>=2`,null,{timeout:5000});
 // Ending the session stops listening and resets the bar.
 await page.click('#rkVoiceMicBtn');
 await page.waitForFunction(String.raw`() => document.querySelector('#rkVoiceBar')?.getAttribute('data-on')!=='1'`);
 assert.match((await page.locator('#rkVoiceMicBtn').textContent()) ?? '',/بدء محادثة صوتية/);
 await page.screenshot({path:out+'/voice-session.png'});
 assert.deepEqual(errors,[]);
 console.log('PASS live voice session: mic start, speech-to-prompt, sentence TTS, labeled transcript turns, barge-in cancellation, auto-restart, clean stop');
}finally{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
