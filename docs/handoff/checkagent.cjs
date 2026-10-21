const fs=require('fs');
const d=JSON.parse(fs.readFileSync('data/protocol-sessions.json','utf8'));
const arr=Array.isArray(d)?d:(d.sessions||Object.values(d));
const s=arr.find(x=>x&&x.sessionId==='VMYUOAoLiLQn4WtwyJkdVs');
const str=JSON.stringify(s);
const m=str.match(/"agentId"\s*:\s*"([^"]+)"/i);
console.log('session.agentId =', m?m[1]:'(none found)');
console.log('has extData:', str.includes('extData'));
const em=str.match(/.{30}agentId.{60}/i);
console.log('ctx:', em?em[0]:'n/a');
const md=str.match(/"mode"\s*:\s*"([^"]+)"/i);
console.log('session.mode =', md?md[1]:'n/a');
// find the QA agent id
for (const f of ['data/agents.json','data/companion-agents.json','data/companionAgents.json']){
  try{
    const a=JSON.parse(fs.readFileSync(f,'utf8'));
    const list=Array.isArray(a)?a:(a.agents||Object.values(a));
    const q=list.find(x=>x&&/QA Verifier Bot/.test(JSON.stringify(x)));
    if(q) console.log(f,'QA agent id =', q.id, '| name=', q.name, '| mode=', q.mode, '| workMode=', q.workMode);
  }catch(e){}
}
