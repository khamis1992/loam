let sqlite;
try{ sqlite=require('node:sqlite'); }catch(e){ console.log('no node:sqlite:',e.message); process.exit(0); }
const {DatabaseSync}=sqlite;
const db=new DatabaseSync('data/manus.db',{readOnly:true});
const tabs=db.prepare("select name from sqlite_master where type='table'").all().map(t=>t.name);
console.log('tables:',tabs.join(','));
for(const t of tabs){
  try{
    const cols=db.prepare(`pragma table_info(${t})`).all().map(c=>c.name);
    const col=cols.includes('agentId')?'agentId':(cols.includes('agent_id')?'agent_id':null);
    if(col){
      const rows=db.prepare(`select * from ${t} order by rowid desc limit 4`).all();
      console.log(`\n[${t}] (col ${col}):`);
      for(const r of rows) console.log('  id=',r.id,'| '+col+'=',r[col],'| t=',String(r.title||r.prompt||'').slice(0,45));
    }
  }catch(e){}
}
