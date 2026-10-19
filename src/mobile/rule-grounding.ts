import type {OllamaClient} from '../ollama.js';
import type {MobileCollection} from '../../ui/mobile-data.js';
import {extractJson} from '../agent/planner.js';

export type RuleDecision={collectionId:string;ruleId:string;keep:boolean;quote:string|null;reason:string};
export async function groundDraftRules(o:{collections:MobileCollection[];brief:string;model:string;ollama:Pick<OllamaClient,'chat'>;signal:AbortSignal}){
 const rules=o.collections.flatMap(c=>(c.rules||[]).map(rule=>({collectionId:c.id,collection:c.title,fields:c.fields.map(f=>({id:f.id,label:f.label,type:f.type})),rule})));
 if(!rules.length)return [] as RuleDecision[];
 const text={type:'string',minLength:1,maxLength:600};
 const format={type:'object',additionalProperties:false,required:['decisions'],properties:{decisions:{type:'array',minItems:rules.length,maxItems:rules.length,items:{type:'object',additionalProperties:false,required:['collectionId','ruleId','keep','quote','reason'],properties:{collectionId:text,ruleId:text,keep:{type:'boolean'},quote:{anyOf:[text,{type:'null'}]},reason:text}}}}};
 const result=await o.ollama.chat({model:o.model,signal:o.signal,timeoutMs:180000,temperature:0,...(!o.model.includes('cloud')?{format}:{}),messages:[
  {role:'system',content:'RULE SUPPORT AUDIT. You are checking requirements, not writing an application. For each candidate rule decide whether the USER REQUEST actually requires that exact restriction. Return JSON {decisions:[{collectionId,ruleId,keep,quote,reason}]}. Required and unique are different: a required name must be nonempty but may repeat. A ban on duplicate ACTIVE records does not ban duplicates among inactive/cancelled/returned records. Reject restrictions that are not stated. For keep:true quote the exact supporting text from request, not from a rule message. For keep:false quote:null and explain the unsupported restriction. Do not change rules, invent rules, or produce collections. Include one decision per candidate.'},
  {role:'user',content:JSON.stringify({request:o.brief,candidateRules:rules})}
 ]});
 o.signal.throwIfAborted();const parsed=extractJson(result.content) as {decisions?:RuleDecision[]};
 if(!Array.isArray(parsed?.decisions)||parsed.decisions.length!==rules.length)throw Error('Rule support audit must decide every candidate');
 const seen=new Set<string>(),normalize=(s:string)=>s.replace(/\s+/g,' ').trim();
 for(const d of parsed.decisions){
  if(!d||typeof d.keep!=='boolean'||typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>600)throw Error('Invalid rule support decision');
  const key=d.collectionId+'.'+d.ruleId;if(seen.has(key)||!rules.some(r=>r.collectionId===d.collectionId&&r.rule.id===d.ruleId))throw Error('Unknown or repeated rule decision');seen.add(key);
  if(d.keep&&(typeof d.quote!=='string'||!d.quote.trim()||!normalize(o.brief).includes(normalize(d.quote))))throw Error('Rule support evidence must quote the request');
  if(!d.keep&&d.quote!==null)throw Error('Unsupported rule needs quote:null');
 }
 return parsed.decisions;
}
