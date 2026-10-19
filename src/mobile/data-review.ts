import type {ChatMessage,OllamaClient} from '../ollama.js';
import {extractJson} from '../agent/planner.js';
import {collectionsSchema} from './schema.js';
import {validateCollections,type MobileCollection} from '../../ui/mobile-data.js';
import {groundDraftRules} from './rule-grounding.js';

// Optional grammar branches are easily skipped by small local models. A review must
// explicitly decide every numeric bound and uniqueness condition, including absence.
export const dataReviewSchema=(()=>{
 const collections=structuredClone(collectionsSchema);
 for(const field of collections.items.properties.fields.items.oneOf)field.required.push('required');
 const number=collections.items.properties.fields.items.oneOf.find(f=>f.properties.type.const==='number')!;
 number.required.push('min','max','integer');
 for(const key of ['min','max'] as const)(number.properties as any)[key]={anyOf:[(number.properties as any)[key],{type:'null'}]};
 const unique=collections.items.properties.rules.items.oneOf.find(r=>r.properties.type.const==='unique')!;
 unique.required.push('when');
 (unique.properties as any).when={anyOf:[unique.properties.when,{type:'null'}]};
 const text={type:'string',minLength:1,maxLength:600},key={type:'string',minLength:1,maxLength:80};
 const item={type:'object',additionalProperties:false,required:['collectionId','ruleId','reason'],properties:{collectionId:key,ruleId:key,reason:text}};
 return {type:'object',additionalProperties:false,required:['collections','removedRules','ruleEvidence'],properties:{collections,
  removedRules:{type:'array',maxItems:256,items:item},
  ruleEvidence:{type:'array',maxItems:256,items:{...item,required:[...item.required,'quote'],properties:{...item.properties,quote:text}}}
 }};
})();

export type RuleAudit={collectionId:string;ruleId:string;reason:string;quote?:string};
export function checkedRuleAudit(input:unknown,previous:MobileCollection[],next:MobileCollection[],brief:string){
 const raw=input as {removedRules?:unknown;ruleEvidence?:unknown};
 const read=(value:unknown,evidence:boolean):RuleAudit[]=>{
  if(!Array.isArray(value)||value.length>256)throw Error('Data review must include bounded removedRules and ruleEvidence arrays');
  const ids=new Set<string>();
  return value.map(item=>{
   if(!item||typeof item!=='object')throw Error('Invalid rule audit');
   for(const key of ['collectionId','ruleId','reason',...(evidence?['quote']:[])])if(typeof item[key]!=='string'||!item[key].trim()||item[key].length>600)throw Error('Invalid rule audit '+key);
   const id=item.collectionId+'.'+item.ruleId;if(ids.has(id))throw Error('Duplicate rule audit '+id);ids.add(id);
   const before=previous.find(c=>c.id===item.collectionId)?.rules?.find(r=>r.id===item.ruleId);
   const after=next.find(c=>c.id===item.collectionId)?.rules?.find(r=>r.id===item.ruleId);
   if(evidence){if(!after)throw Error('Evidence references missing rule '+id);const normalize=(s:string)=>s.replace(/\s+/g,' ').trim();if(!normalize(brief).includes(normalize(item.quote)))throw Error('Rule evidence must quote the actual user request: '+id);}
   else if(!before||after)throw Error('Removed-rule audit must identify an actually removed draft rule: '+id);
   return {collectionId:item.collectionId,ruleId:item.ruleId,reason:item.reason,...(evidence?{quote:item.quote}:{})};
  });
 };
 const removedRules=read(raw?.removedRules,false),ruleEvidence=read(raw?.ruleEvidence,true);
 for(const c of next)for(const r of c.rules||[])if(!ruleEvidence.some(e=>e.collectionId===c.id&&e.ruleId===r.id))throw Error('Missing user requirement evidence for '+c.id+'.'+r.id);
 return {removedRules,ruleEvidence};
}

export function checkedDataReview(input:unknown,previous:MobileCollection[],brief:string):MobileCollection[]{
 const raw=structuredClone(input) as {collections?:MobileCollection[]};
 if(!Array.isArray(raw?.collections))throw Error('Data review must return collections');
 for(const c of raw.collections){
  if(!Array.isArray(c.fields))throw Error('Data review must return fields');
  if(c.fields.some(f=>typeof f.required!=='boolean'))throw Error('Every reviewed field needs an explicit required boolean');
  for(const f of c.fields)if(f.type==='number'){
   if(!['min','max','integer'].every(k=>Object.hasOwn(f,k)))throw Error(`Explicit min, max (number or null), and integer are required for ${c.id}.${f.id}`);
   for(const key of ['min','max'] as const)if(f[key]===null)delete f[key];
  }
  for(const r of c.rules||[])if(r.type==='unique'){
   if(!Object.hasOwn(r,'when'))throw Error(`Explicit when (condition or null) is required for ${c.id}.${r.id}`);
   if(r.when===null)delete r.when;
  }
 }
 const checked=validateCollections(raw.collections);
 const audit=checkedRuleAudit(input,previous,checked,brief);
 if(checked.length!==previous.length||previous.some(c=>{const next=checked.find(n=>n.id===c.id);return !next||c.fields.some(f=>!next.fields.some(n=>n.id===f.id));}))throw Error('Data review must preserve collection IDs and existing field IDs');
 // A review may add or correct rules; silent omission must not weaken the draft.
 for(const c of previous){
  const next=checked.find(n=>n.id===c.id)!;
  for(const f of c.fields){const after=next.fields.find(n=>n.id===f.id)!;
   if(f.required&&!after.required)throw Error(`Data review removed required field constraint: ${c.id}.${f.id}`);
   if(f.type==='number'&&after.type==='number')for(const key of ['min','max','integer'] as const)if(f[key]!==undefined&&f[key]!==false&&after[key]===undefined)throw Error(`Data review dropped ${key}: ${c.id}.${f.id}`);
  }
  for(const rule of c.rules||[]){const after=next.rules?.find(r=>r.id===rule.id);
   if(!after){if(audit.removedRules.some(r=>r.collectionId===c.id&&r.ruleId===rule.id))continue;throw Error(`Data review dropped rule ${c.id}.${rule.id} without an explicit removal reason`);}
   if(rule.type==='unique'&&rule.when&&after.type==='unique'&&!after.when)throw Error(`Data review dropped condition ${c.id}.${rule.id}; unconditional uniqueness prevents release and reuse`);
  }
 }
 return checked;
}

export async function reviewMobileData(o:{collections:MobileCollection[];brief:string;model:string;ollama:Pick<OllamaClient,'chat'>;signal:AbortSignal;rules:string;onRepair?:(attempt:number,reason:string)=>void}){
 const decisions=await groundDraftRules(o);
 const removableRules=o.collections.flatMap(c=>(c.rules||[]).map(r=>({collectionId:c.id,ruleId:r.id})));
 const reviewFormat=structuredClone(dataReviewSchema);
 reviewFormat.properties.removedRules.maxItems=removableRules.length;
 const messages:ChatMessage[]=[{role:'system',content:`You review the DATA CONTRACT of a mobile app against the user's product requirements. Return ONLY JSON {"collections":[...],"removedRules":[{collectionId,ruleId,reason}],"ruleEvidence":[{collectionId,ruleId,quote,reason}]}. The user request is the source of truth; the draft may contain invented restrictions. For EVERY resulting rule, quote the exact supporting substring of the user request and explain how this rule implements it. If a draft rule has no supporting requirement, remove it and record its collectionId/ruleId and reason in removedRules. Preserve IDs of retained rules. REQUIRED IS NOT UNIQUE: a required name only forbids an empty value; it does not forbid repeated names. The phrase "اسمًا مطلوبًا" supports required:true ONLY, never a unique rule. A request for a required title/name allows repeated titles/names unless it separately explicitly forbids duplicates. REMOVE draft rules that confuse required with unique. Do not invent uniqueness for names, titles, or other labels unless the request requires it. A restriction on active records does NOT imply a restriction on inactive records: do not create complementary uniqueness rules for cancelled/returned/completed records. Repeated cancellation/return cycles must remain possible. Use empty audit arrays when there are no entries. You are not designing screens. Keep every collection ID and existing field ID, and preserve all requested fields. Correct types and missing constraints. Every field must explicitly include required:true or required:false. ruleEvidence has exactly one entry per named collection.rules rule and no entries for field properties such as required, min, max or integer. A requested link to a record MUST be type relation with collectionId, never text. A stated minimum or maximum MUST be encoded as min/max on the number field, not merely described in text. Every number field MUST include min (number or null), max (number or null), integer (boolean). Use null ONLY if no bound is requested. For example "عدد صحيح لا يقل عن 1" means min:1,max:null,integer:true; "بين 15 و180" means min:15,max:180. Every unique rule MUST include when: a condition object or null for unconditional uniqueness. When the user permits reuse after cancellation, return, completion, etc., uniqueness MUST be conditional on the active state. For example when:{field:"status",equals:"مؤكد"} or when:{field:"returned",equals:false}. Do not add a second unconditional rule on the same fields. Preserve existing conditions. Check each sentence of the request: required fields, record relationships, lower/upper bounds, valid date ordering, uniqueness including conditional uniqueness, and every allowed option. Add the supported rules that enforce those requirements. Do not invent services or unsupported behavior. ${o.rules} In this review, remove unsupported draft rules with an explicit removedRules entry; preserving a draft rule is not a reason to keep a restriction the user never requested.`},{role:'user',content:JSON.stringify({request:o.brief,collections:o.collections})}];
 messages.push({role:'user',content:JSON.stringify({ruleSupportAudit:decisions,removableRules,instruction:'Honor these independently checked rule decisions. removedRules may ONLY reference an entry in removableRules that is actually removed. If removableRules is empty, removedRules MUST be []. Remove unsupported restrictions and include their removal reasons. Supported quotes come from request, not error messages.'})});
 const meaning=(r:any)=>JSON.stringify(r.type==='unique'?{type:r.type,fields:[...r.fields].sort(),when:r.when||null}:{type:r.type,field:r.field,otherField:r.otherField,operator:r.operator});
 for(let attempt=1;attempt<=2;attempt++){
  o.signal.throwIfAborted();
  const result=await o.ollama.chat({model:o.model,messages,temperature:0,signal:o.signal,timeoutMs:180000,...(!o.model.includes('cloud')?{format:reviewFormat}:{})});
  o.signal.throwIfAborted();
  try{const parsed=extractJson(result.content),checked=checkedDataReview(parsed,o.collections,o.brief);
   for(const d of decisions.filter(d=>!d.keep)){const old=o.collections.find(c=>c.id===d.collectionId)!.rules!.find(r=>r.id===d.ruleId)!;
    if(checked.find(c=>c.id===d.collectionId)?.rules?.some(r=>meaning(r)===meaning(old)))throw Error(`Rule support audit rejected ${d.collectionId}.${d.ruleId}: ${d.reason}. Remove this restriction; renaming it does not fix it.`);
   }
   return {collections:checked,audit:{...checkedRuleAudit(parsed,o.collections,checked,o.brief),decisions},usage:result.usage,attempts:attempt+(decisions.length?1:0)};
  }catch(error){if(attempt===2)throw error;const reason=error instanceof Error?error.message:String(error);o.onRepair?.(attempt,reason);
   messages.push({role:'assistant',content:result.content.slice(0,50000)},{role:'user',content:`Review rejected: ${reason}. Return the complete corrected review. A quote must be an EXACT substring of the original request below, NOT a message/label from the draft. If no user requirement supports a rule, remove it and explain in removedRules; do not fabricate evidence. Original request: ${o.brief}`});
  }
 }
 throw Error('Data review failed');
}
