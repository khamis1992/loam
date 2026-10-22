const fs=require('fs');
const a=JSON.parse(fs.readFileSync('data/agents.json','utf8'));
const list=Array.isArray(a)?a:(a.agents||Object.values(a));
const q=list.find(x=>x&&/QA Verifier Bot/.test(JSON.stringify(x)));
console.log('persisted name =', q&&q.name, '| id =', q&&q.id);
