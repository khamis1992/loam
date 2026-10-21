import WebSocket from 'ws';
import fs from 'fs';
const BASE='http://127.0.0.1:9333';
const prompt=process.argv[2];
const shotOut=process.argv[3];
const waitMs=parseInt(process.argv[4]||'90000');
async function pages(){const r=await fetch(BASE+'/json');return (await r.json()).filter(t=>t.type==='page');}
function Conn(u){const ws=new WebSocket(u,{maxPayload:256*1024*1024});let id=0;const w=new Map();
 const ready=new Promise(r=>ws.on('open',r));
 ws.on('message',d=>{const m=JSON.parse(d);if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
 return{ready,send:(method,params={})=>{const i=++id;return new Promise((res,rej)=>{w.set(i,m=>m.error?rej(new Error(JSON.stringify(m.error))):res(m.result));ws.send(JSON.stringify({id:i,method,params}));});},close:()=>ws.close()};}
const ev=async(c,expr)=>{const r=await c.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});return r.result?.value;};
(async()=>{
 let t=(await pages())[0];const c=Conn(t.webSocketDebuggerUrl);await c.ready;
 await c.send('Page.enable');await c.send('Runtime.enable');
 // go home
 await c.send('Page.navigate',{url:'app://agent/app'});await new Promise(r=>setTimeout(r,4000));
 // fill + submit
 const esc=JSON.stringify(prompt);
 await ev(c,`(()=>{const ta=document.querySelector('textarea');const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;set.call(ta,${esc});ta.dispatchEvent(new Event('input',{bubbles:true}));return 1;})()`);
 await new Promise(r=>setTimeout(r,800));
 await ev(c,`(()=>{const ta=document.querySelector('textarea');ta.focus();for(const ty of ['keydown','keypress','keyup'])ta.dispatchEvent(new KeyboardEvent(ty,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));return 1;})()`);
 await new Promise(r=>setTimeout(r,2500));
 const url=await ev(c,'location.href');
 // wait for completion: poll body for "Task completed" or until timeout
 const start=Date.now();let done=false;
 while(Date.now()-start<waitMs){
   const b=await ev(c,'document.body.innerText');
   if(/Task completed|Worked for/i.test(b) && !/Thinking|is working|Working/i.test(b.slice(-400))) {done=true;}
   if(done) break;
   await new Promise(r=>setTimeout(r,5000));
 }
 await new Promise(r=>setTimeout(r,1500));
 const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(shotOut,Buffer.from(r.data,'base64'));
 console.log(JSON.stringify({url,done,elapsedMs:Date.now()-start,shot:shotOut}));
 c.close();process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
