const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('data/manus.db',{readOnly:true});
// map session -> task via protocol-sessions.json
const fs=require('fs');
const ps=JSON.parse(fs.readFileSync('data/protocol-sessions.json','utf8'));
const arr=Array.isArray(ps)?ps:(ps.sessions||Object.values(ps));
const s=arr.find(x=>x&&x.sessionId==='bdsbuVf4476GUHDmVn8vAf');
console.log('session.taskId =', s&&s.taskId);
const tid=s&&s.taskId;
const rows=db.prepare("select * from entities where kind='tasks'").all();
console.log('total task rows:',rows.length);
const parsed=rows.map(r=>({id:r.id,o:JSON.parse(r.payload)}));
// show the 3 most recent by createdAt
parsed.sort((a,b)=>(b.o.createdAt||0)-(a.o.createdAt||0));
for(const p of parsed.slice(0,3)){
  console.log('recent: id=',p.o.id,'| agentId=',p.o.agentId,'| mode=',p.o.mode,'| status=',p.o.status,'| title=',String(p.o.title||'').slice(0,35));
}
if(tid){
  const hit=parsed.find(p=>p.o.id===tid||p.id===tid);
  if(hit) console.log('MATCH taskId',tid,'-> agentId=',hit.o.agentId,'mode=',hit.o.mode);
  else console.log('taskId',tid,'not found in entities yet');
}
