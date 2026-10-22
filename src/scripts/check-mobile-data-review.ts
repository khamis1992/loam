import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildMobile} from '../mobile/build.js';
import {saveMobile,readMobile} from '../mobile/store.js';
import {recordsFixture} from './mobile-records-fixture.js';
import type {ChatOptions} from '../ollama.js';
import {checkedDataReview,reviewMobileData} from '../mobile/data-review.js';
import {groundDraftRules} from '../mobile/rule-grounding.js';

const explicit=(collections:unknown)=>JSON.parse(JSON.stringify(collections,(key,value)=>{
 if(value?.type==='number'&&value?.id)return {required:false,min:null,max:null,integer:false,...value};
 if(['text','date','boolean','select','relation'].includes(value?.type)&&value?.id)return {required:false,...value};
 if(value?.type==='unique'&&value?.id)return {when:null,...value};
 return value;
}));

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-data-review-'));
const blank={version:1,title:'New',accent:'#267965',direction:'rtl',screens:[{id:'home',title:'Home',blocks:[]}]};
const initial=saveMobile(root,blank,0),draft=structuredClone(recordsFixture);draft.collections![1]!.fields.find(f=>f.id==='project')!.type='text';
let calls=0;const phases:string[]=[];
await buildMobile({root,expectedRevision:initial.revision,model:'fixture',brief:'Create tasks linked to projects, with hours at least zero.',signal:new AbortController().signal,emit:e=>{if(e.type==='phase')phases.push(String(e.phase));},ollama:{chat:async(options:ChatOptions)=>{
 calls++;const review=options.messages[0]!.content.includes('DATA CONTRACT');if(review){assert.match(options.messages[0]!.content,/minimum or maximum/);assert.match(options.messages[1]!.content,/hours at least zero/);}
 const corrected=structuredClone(recordsFixture.collections!);corrected[1]!.fields.find(f=>f.id==='hours')!.min=0;
 return {model:'fixture',content:JSON.stringify(review?{collections:explicit(corrected),removedRules:[],ruleEvidence:[]}:draft),toolCalls:[],usage:{promptTokens:0,completionTokens:0,durationMs:0}};
}}});
assert.equal(calls,2);assert.ok(phases.includes('data_review'));const saved=readMobile(root)!;assert.equal(saved.collections![1]!.fields.find(f=>f.id==='project')!.type,'relation');assert.equal(saved.collections![1]!.fields.find(f=>f.id==='hours')!.min,0);
// An invalid review cannot silently drop fields or commit a partial new project.
const other=fs.mkdtempSync(path.join(os.tmpdir(),'loam-data-review-fail-'));saveMobile(other,blank,0);
await assert.rejects(buildMobile({root:other,expectedRevision:1,model:'fixture',brief:'Create linked records',signal:new AbortController().signal,emit:()=>{},ollama:{chat:async options=>({model:'fixture',content:JSON.stringify(options.messages[0]!.content.includes('DATA CONTRACT')?{collections:[]}:draft),toolCalls:[],usage:{promptTokens:0,completionTokens:0,durationMs:0}})}}));assert.equal(readMobile(other)!.revision,1);
const bounded=structuredClone(recordsFixture.collections!);const hours=bounded[1]!.fields.find(f=>f.id==='hours')!;hours.min=0;hours.integer=true;
const title=bounded[1]!.titleField,done=bounded[1]!.fields.find(f=>f.type==='boolean')!.id;
bounded[1]!.rules=[{id:'active_title',type:'unique',fields:[title],when:{field:done,equals:false},message:'Already active'}];
const brief='Tasks with the same active title must be unique.';
const audit={removedRules:[] as any[],ruleEvidence:[{collectionId:bounded[1]!.id,ruleId:'active_title',quote:brief,reason:'Prevents duplicate active titles'}]};
const check=(collections:unknown,changes=audit)=>checkedDataReview({collections,...changes},bounded,brief);
const review=explicit(bounded);assert.deepEqual(check(review),bounded);
review[1].fields.find((f:any)=>f.id==='hours').min=null;
assert.throws(()=>check(review),/dropped min/);
review[1].fields.find((f:any)=>f.id==='hours').min=0;review[1].rules[0].when=null;
assert.throws(()=>check(review),/dropped condition/);
delete review[1].rules[0].when;assert.throws(()=>check(review),/Explicit when/);
const corrected=explicit(bounded);corrected[1].rules=[];
assert.throws(()=>check(corrected,{removedRules:[],ruleEvidence:[]}),/without an explicit removal reason/);
const removal={removedRules:[{collectionId:bounded[1]!.id,ruleId:'active_title',reason:'The request allows duplicate titles'}],ruleEvidence:[]};
assert.equal(checkedDataReview({collections:corrected,...removal},bounded,'Duplicate titles are allowed.')[1]!.rules?.length||0,0);
assert.throws(()=>check(explicit(bounded),{removedRules:[],ruleEvidence:[{...audit.ruleEvidence[0]!,quote:'An invented requirement'}]}),/actual user request/);
assert.throws(()=>check(explicit(bounded),{removedRules:[],ruleEvidence:[]}),/Missing user requirement/);
assert.throws(()=>check(explicit(bounded),{removedRules:[{collectionId:bounded[1]!.id,ruleId:'active_title',reason:'Not actually removed'}],ruleEvidence:audit.ruleEvidence}),/actually removed/);
const existingRoot=fs.mkdtempSync(path.join(os.tmpdir(),'loam-existing-review-'));
const existing=saveMobile(existingRoot,{...recordsFixture,collections:bounded},0),reviewEvents:Record<string,unknown>[]=[];
const reviewedResponse={model:'fixture',content:JSON.stringify({collections:corrected,...removal}),toolCalls:[],usage:{promptTokens:0,completionTokens:0,durationMs:0}};
await buildMobile({root:existingRoot,expectedRevision:existing.revision,model:'fixture',brief:'Duplicate titles are allowed.',operation:'review-data',signal:new AbortController().signal,emit:e=>reviewEvents.push(e),ollama:{chat:async options=>options.messages[0]!.content.startsWith('RULE SUPPORT AUDIT')?{...reviewedResponse,content:JSON.stringify({decisions:bounded.flatMap(c=>(c.rules||[]).map(r=>({collectionId:c.id,ruleId:r.id,keep:false,quote:null,reason:'Duplicate titles are allowed'})))})}:reviewedResponse}});
const reviewedProject=readMobile(existingRoot)!;assert.deepEqual(reviewedProject.screens,existing.screens);assert.equal(reviewedProject.revision,2);assert.ok(reviewEvents.some(e=>e.type==='data_reviewed'&&JSON.stringify(e.audit).includes('active_title')));
// A review reply cannot change an existing field type and invalidate stored values.
const incompatible=structuredClone(corrected);incompatible[1].fields.find((f:any)=>f.id==='hours').type='text';for(const key of ['min','max','integer'])delete incompatible[1].fields.find((f:any)=>f.id==='hours')[key];
await assert.rejects(buildMobile({root:existingRoot,expectedRevision:2,model:'fixture',brief:'Review all data rules.',operation:'review-data',signal:new AbortController().signal,emit:()=>{},ollama:{chat:async()=>({...reviewedResponse,content:JSON.stringify({collections:incompatible,removedRules:[],ruleEvidence:[]})})}}),/نوع الحقل/);
assert.equal(readMobile(existingRoot)!.revision,2);
const unsupported={collectionId:bounded[1]!.id,ruleId:'active_title',keep:false,quote:null,reason:'Repeated titles are allowed'};
const localOptions={collections:bounded,brief:'Repeated titles are allowed.',model:'fixture',signal:new AbortController().signal};
const fake=async(content:unknown)=>({...reviewedResponse,content:JSON.stringify(content)});
await assert.rejects(groundDraftRules({...localOptions,ollama:{chat:async()=>fake({decisions:[]})}}),/every candidate/);
await assert.rejects(groundDraftRules({...localOptions,ollama:{chat:async()=>fake({decisions:[{...unsupported,keep:true,quote:'Invented demand'}]})}}),/quote the request/);
let reviewAttempts=0;const renamed=explicit(bounded);renamed[1].rules[0].id='renamed_restriction';
await assert.rejects(reviewMobileData({...localOptions,rules:'',ollama:{chat:async options=>{
 if(options.messages[0]!.content.startsWith('RULE SUPPORT AUDIT'))return fake({decisions:[unsupported]});
 reviewAttempts++;return fake({collections:renamed,removedRules:[{collectionId:bounded[1]!.id,ruleId:'active_title',reason:'Renamed'}],ruleEvidence:[{collectionId:bounded[1]!.id,ruleId:'renamed_restriction',quote:localOptions.brief,reason:'Unsupported interpretation'}]});
}}}),/renaming it does not fix it/);assert.equal(reviewAttempts,2);
const noRules=[{...recordsFixture.collections![0]!,rules:[]}];
await reviewMobileData({...localOptions,collections:noRules,rules:'',ollama:{chat:async options=>{assert.equal((options.format as any).properties.removedRules.maxItems,0,'No draft rules means no possible removal entries');return fake({collections:noRules,removedRules:[],ruleEvidence:[]});}}});
console.log('PASS data review: explicit bounds/conditions, auditable rule removal, exact request evidence, rejection atomicity and preserved IDs');
