import WebSocket from 'ws';
const BASE='http://127.0.0.1:9333';
const arg=k=>{const i=process.argv.indexOf(k);return i>=0?process.argv[i+1]:undefined;};
const cmd=process.argv[2];
async function listPages(){const r=await fetch(BASE+'/json');return (await r.json()).filter(t=>t.type==='page');}
function Conn(wsUrl){const ws=new WebSocket(wsUrl,{maxPayload:256*1024*1024});let id=0;const waits=new Map();const evs=[];
  const ready=new Promise(res=>ws.on('open',res));
  ws.on('message',d=>{const m=JSON.parse(d);if(m.id&&waits.has(m.id)){waits.get(m.id)(m);waits.delete(m.id);}else if(m.method)evs.push(m);});
  return {ready,send:(method,params={})=>{const i=++id;return new Promise((res,rej)=>{waits.set(i,m=>m.error?rej(new Error(JSON.stringify(m.error))):res(m.result));ws.send(JSON.stringify({id:i,method,params}));});},evs,close:()=>ws.close()};}
async function pickPage(){const ps=await listPages();const want=arg('--url');let t=ps[0];if(want)t=ps.find(p=>p.url.includes(want))||ps[0];return t;}
(async()=>{
 if(cmd==='pages'){const ps=await listPages();console.log(ps.map(p=>p.title+' | '+p.url+' | '+p.webSocketDebuggerUrl).join('\n'));return;}
 const t=await pickPage();const c=Conn(t.webSocketDebuggerUrl);await c.ready;
 await c.send('Page.enable');await c.send('Runtime.enable');
 if(cmd==='reload'){await c.send('Page.navigate',{url:arg('--to')||t.url});await new Promise(r=>setTimeout(r,parseInt(arg('--wait')||'4000')));console.log('reloaded',t.url);}
 if(cmd==='eval'){const r=await c.send('Runtime.evaluate',{expression:arg('--js'),returnByValue:true,awaitPromise:true});console.log(JSON.stringify(r.result?.value??r.exceptionDetails??null));}
 if(cmd==='shot'){const r=await c.send('Page.captureScreenshot',{format:'png'});const fs=await import('fs');fs.writeFileSync(arg('--out'),Buffer.from(r.data,'base64'));console.log('saved',arg('--out'),'url=',t.url);}
 if(cmd==='info'){console.log('title=',t.title,'url=',t.url);}
 c.close();process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
