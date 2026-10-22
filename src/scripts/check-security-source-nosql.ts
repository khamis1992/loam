import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {analyzeNoSqlSource} from '../security/source-nosql.js';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';
import {sarif} from '../security/findings.js';
const prefix='const mongoose=require("mongoose"); function handler(req){';
const candidates=[
  'const filter=req.body; connect((err,db)=>db.find(filter));',
  'const filter={}; filter.title=req.query.title; connect(function(err,db){db.find(filter);});',
  'const filter={title:req.body.title}; connect(()=>{const alias=filter; later(()=>Model.find(alias));});',
  'const filter=req.query; function nested(){Model.find(filter);} nested();',
  'const filter={}; filter.title=req.body.title; Model.find(filter);',
  'const filter={}; filter["title"]=req.query.title; Model.find(filter);',
  'const filter={}; filter[req.query.key]="fixed"; Model.find(filter);',
  'const filter={}; const alias=filter; filter.title=req.body.title; Model.find(alias);',
  'const filter={}; filter.title=req.body.title; filter.title="fixed"; Model.find(filter);',
  'Model.find(req.body);','Model.findOne({name:req.query.name});',
  'const filter=req.query; Model.find(filter);','const filter={name:req.body.name}; Model.countDocuments(filter);',
  'Model.distinct("type",req.body);','Model.updateOne(req.query,{$set:{name:"fixed"}});',
  'Model.aggregate([{$match:req.body}]);','Model.find({...req.body});',
  'Model.find(JSON.parse(req.params.filter));','Model.find({[req.body.key]:"value"});',
  'const filter={name:req.query.name}; const alias=filter; Model.find(alias);',
  'Model.find(req["query"]);',
  'const value=req.query.name; if(typeof value==="string"){Model.find({name:JSON.parse(value)});}',
  'const value=req.query.name; if(typeof value==="string"){}else{Model.find({name:value});}',
  'const value=req.query.name; if(typeof value==="string"){} Model.find({name:value});',
];
const controls=[
  'const filter=req.body; connect((filter)=>Model.find(filter));',
  'const filter=req.body; connect(()=>{const filter={title:"fixed"}; Model.find(filter);});',
  'let filter=req.body; connect(()=>Model.find(filter)); filter={};',
  'const filter={}; connect(()=>Model.find(filter)); filter.title=req.body.title;',
  'const filter={}; connect(()=>{filter.title=req.body.title;}); later(()=>Model.find(filter));',
  'const filter={title:String(req.body.title)}; connect(()=>Model.find(filter));',
  'const filter={}; filter.title=String(req.body.title); Model.find(filter);',
  'const filter={}; filter.title={$eq:req.body.title}; Model.find(filter);',
  'const filter={}; filter.$eq=req.body.title; Model.find(filter);',
  'const filter={}; Model.find(filter); filter.title=req.body.title;',
  'const filter={}; {const filter={}; filter.title=req.body.title;} Model.find(filter);',
  'const filter={}; function later(){filter.title=req.body.title;} Model.find(filter);',
  'req.body={title:"fixed"}; Model.find(req.body);',
  'let filter={}; filter.title=req.body.title; filter={}; Model.find(filter);',
  'Model.find({name:"fixed"});','Model.find({name:String(req.body.name)});',
  'Model.find({age:Number(req.query.age)});','Model.find({name:{$eq:req.body.name}});',
  'Model.find({id:req.params.id});','Model.find(x=>x.name===req.query.name);',
  'Model.updateOne({id:"fixed"},{$set:req.body});','Model.distinct(req.query.field,{id:"fixed"});',
  'let filter=req.body; filter={name:"fixed"}; Model.find(filter);',
  'const filter=req.body; {const filter={name:"fixed"}; Model.find(filter);}',
  'const req2={body:{name:"fixed"}}; Model.find(req2.body);',
  'Model.find(JSON.parse("{\"name\":\"fixed\"}"));',
  'function nested(req){const req2={body:"fixed"}; Model.find(req2.body);}',
  'const value=req.query.name; if(typeof value==="string"){Model.find({name:value});}',
  'const value=req.query.name; if("number"===typeof value){Model.find({age:value});}',
];
for(const ext of ['js','ts']){
  for(const source of candidates)assert.equal(analyzeNoSqlSource('fixture.'+ext,prefix+source+'}').risks.length,1,source);
  for(const source of controls)assert.equal(analyzeNoSqlSource('fixture.'+ext,prefix+source+'}').risks.length,0,source);
}
const modelPrefix='const mongoose=require("mongoose"); const Document=mongoose.model("Doc",{}); function handler(req){const filter=req.body;';
const callbackControls=[
  'Document.findOne({},(failure,result)=>failure.count(filter));',
  'Document.find({}).exec((failure,result)=>failure.count(filter));',
  'Document.findOne({}).then(undefined,failure=>failure.count(filter));',
  'Document.count({},(failure,total)=>total.count(filter));',
  'Document.countDocuments({}).then(total=>total.find(filter));',
];
const callbackCandidates=[
  'Document.findOne({},(failure,result)=>result.count(filter));',
  'Unknown.findOne({},(failure,result)=>failure.count(filter));',
  'Document.findOne({},(failure,result)=>{failure=Other; failure.count(filter);});',
  'Document.findOne=custom; Document.findOne({},failure=>failure.count(filter));',
  'Document[req.query.method]=custom; Document.findOne({},failure=>failure.count(filter));',
];
for(const ext of ['js','ts']){
  for(const source of callbackControls)assert.equal(analyzeNoSqlSource('callback.'+ext,modelPrefix+source+'}').risks.length,0,source);
  for(const source of callbackCandidates)assert.equal(analyzeNoSqlSource('callback.'+ext,modelPrefix+source+'}').risks.length,1,source);
}
assert.equal(analyzeNoSqlSource('x.js','function handler(req){Model.find(req.body);}').risks.length,0,'No MongoDB/Mongoose import');
assert.equal(analyzeNoSqlSource('x.py','pass').status,'unsupported');
assert.equal(analyzeNoSqlSource('x.js','Model.find(').status,'parse_error');
const deep=prefix+'const q0=req.body;'+Array.from({length:40},(_,i)=>`const q${i+1}=q${i};`).join('')+'Model.find(q40);}';
assert.equal(analyzeNoSqlSource('deep.js',deep).status,'limit_reached');
assert.equal(analyzeNoSqlSource('cycle.js',prefix+'const filter={}; filter.self=filter; Model.find(filter);}').status,'limit_reached');
const wide=prefix+'const filter={};'+Array.from({length:2100},(_,i)=>`filter.k${i}="fixed";`).join('')+'Model.find(filter);}';
assert.equal(analyzeNoSqlSource('wide.js',wide).status,'limit_reached','Property-write traversal shares the sink expansion budget');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-nosql-'));const file=path.join(root,'filter.js');
fs.writeFileSync(file,prefix+candidates[0]+'}');
async function finish(id:string){for(let n=0;n<200;n++){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');}
const run=await finish(startAssessment(root,{includeSource:true}).id),finding=run.findings.find(f=>f.check==='source_nosql')!;
assert.ok(finding);assert.equal(finding.confidence,'review');assert.equal(finding.target,'filter.js:1');
assert.ok(run.scan!.sourceHashes!['filter.js']);assert.match(finding.remediation!,/strict schema/);
assert.equal(sarif(run.findings).runs[0]!.results.find(r=>r.ruleId==='source_nosql')!.locations![0]!.physicalLocation.artifactLocation.uri,'filter.js');
const repeat=await finish(retestAssessment(root,run.id,{authorized:true}).id);assert.ok(repeat.comparison!.persistent.includes(finding.fingerprint));
fs.writeFileSync(file,prefix+controls[0]+'}');
const edited=await finish(retestAssessment(root,run.id,{authorized:true}).id);assert.ok(edited.comparison!.unverified.includes(finding.fingerprint));
fs.writeFileSync(file,deep);const limited=await finish(startAssessment(root,{includeSource:true}).id);
assert.equal(limited.status,'partial');assert.equal(limited.scan!.coverage!.nosqlLimited,1);
console.log(`PASS: ${candidates.length} NoSQL candidates and ${controls.length} controls in JS/TS, source evidence/SARIF/retest and partial expansion coverage`);
