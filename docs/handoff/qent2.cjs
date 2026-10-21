const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('data/manus.db',{readOnly:true});
const needle='bdsbuVf4476GUHDmVn8vAf';
const rows=db.prepare("select * from entities where kind='tasks'").all();
for(const r of rows){
  if(String(r.id)===needle||r.payload.includes(needle)){
    const o=JSON.parse(r.payload);
    console.log('task id=',o.id,'| agentId=',o.agentId,'| mode=',o.mode,'| status=',o.status,'| title=',String(o.title||'').slice(0,40));
  }
}
