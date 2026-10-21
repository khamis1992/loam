const path=require('path');
let Database;
try{ Database=require(path.join(process.cwd(),'node_modules','better-sqlite3')); }
catch(e){ console.log('no better-sqlite3:',e.message); process.exit(0); }
const db=new Database('data/manus.db',{readonly:true});
const tabs=db.prepare("select name from sqlite_master where type='table'").all().map(t=>t.name);
console.log('tables:',tabs.join(','));
for(const t of tabs){
  try{
    const cols=db.prepare(`pragma table_info(${t})`).all().map(c=>c.name);
    if(cols.includes('agentId')||cols.includes('agent_id')){
      const col=cols.includes('agentId')?'agentId':'agent_id';
      const rows=db.prepare(`select * from ${t} order by rowid desc limit 3`).all();
      console.log(`\n[${t}] last rows (${col}):`);
      for(const r of rows) console.log('  id=',r.id,'| '+col+'=',r[col],'| title=',(r.title||r.prompt||'').toString().slice(0,40));
    }
  }catch(e){}
}
