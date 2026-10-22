const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('data/manus.db',{readOnly:true});
const cols=db.prepare("pragma table_info(entities)").all().map(c=>c.name);
console.log('entities cols:',cols.join(','));
const rows=db.prepare("select * from entities").all();
console.log('row count:',rows.length);
const needle='task_mvgyei5v02ffeef65983';
for(const r of rows){
  const blob=JSON.stringify(r);
  if(blob.includes(needle)){
    // find the json value column
    for(const c of cols){
      const v=r[c];
      if(typeof v==='string'&&v.includes(needle)){
        try{const o=JSON.parse(v);console.log('MATCH col',c,'-> type=',r.type||r.kind,'agentId=',o.agentId,'mode=',o.mode,'status=',o.status,'title=',String(o.title||'').slice(0,40));}
        catch(e){console.log('raw match col',c,':',v.slice(0,300));}
      }
    }
  }
}
