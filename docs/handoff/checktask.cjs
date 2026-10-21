const fs=require('fs');
const files=fs.readdirSync('data').filter(f=>/task/i.test(f));
console.log('task files:',files);
for(const f of files){
  try{
    const raw=fs.readFileSync('data/'+f,'utf8');
    if(raw.includes('task_mvgyei5v02ffeef65983')){
      const d=JSON.parse(raw);
      const arr=Array.isArray(d)?d:(d.tasks||Object.values(d));
      const t=arr.find(x=>x&&JSON.stringify(x).includes('task_mvgyei5v02ffeef65983'));
      console.log('FOUND in',f);
      console.log('  id=',t.id,'agentId=',t.agentId,'mode=',t.mode,'title=',(t.title||'').slice(0,40));
    }
  }catch(e){console.log(f,'ERR',e.message)}
}
