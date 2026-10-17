import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'loam-agents-'));
process.env.MANUS_LOCAL_DATA_DIR=dir;
const {createAgent,updateAgent,listAgents}=await import('../server/agents.js');
const {LOAM_MODES}=await import('../modes/catalog.js');
for(const mode of LOAM_MODES){const a=createAgent({name:mode.id,mode:mode.id});assert.equal(a.mode,mode.id);}
const count=listAgents().length;
assert.throws(()=>createAgent({name:'bad',mode:'unknown'}),/Unknown Loam mode/);
assert.equal(listAgents().length,count);
const a=listAgents()[0];assert.ok(a);const original=a.name;
assert.throws(()=>updateAgent(a.id,{name:'must not mutate',mode:'unknown'}),/Unknown Loam mode/);
assert.equal(a.name,original);
assert.equal(updateAgent(a.id,{mode:'write'})?.mode,'write');
console.log('Loam agents: seven modes accepted; unknown create/update rejected without partial mutation.');
