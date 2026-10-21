import WebSocket from 'ws';
const BASE='http://127.0.0.1:9333';
const match=process.argv[2];
async function pages(){const r=await fetch(BASE+'/json');return (await r.json()).filter(t=>t.type==='page');}
function Conn(u){const ws=new WebSocket(u,{maxPayload:256*1024*1024});let id=0;const w=new Map();
 const ready=new Promise(r=>ws.on('open',r));
 ws.on('message',d=>{const m=JSON.parse(d);if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
 return{ready,send:(method,params={})=>{const i=++id;return new Promise((res,rej)=>{w.set(i,m=>m.error?rej(new Error(JSON.stringify(m.error))):res(m.result));ws.send(JSON.stringify({id:i,method,params}));});}};}
const ev=async(c,expr)=>{const r=await c.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});return r.result?.value;};
(async()=>{
 const t=(await pages())[0];const c=Conn(t.webSocketDebuggerUrl);await c.ready;
 await c.send('Runtime.enable');
 const rect=await ev(c,`(()=>{const b=[...document.querySelectorAll('button,div,li')].filter(x=>new RegExp(${JSON.stringify(match)}).test(x.textContent)).sort((a,b)=>a.textContent.length-b.textContent.length)[0];if(!b)return null;const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
 if(!rect){console.log('no match');process.exit(1);}
 await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x,y:rect.y});
 await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1});
 await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x,y:rect.y,button:'left',clickCount:1});
 console.log('clicked at',JSON.stringify(rect));
 process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
