import {inScope,type CampaignScope} from './scope.js';
export interface ApiOperationPlan {path:string;method:string;urls:string[];reason?:string}
export interface OpenApiPlan {operations:ApiOperationPlan[];seeds:string[]}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function planOpenApi(input:unknown,scope:CampaignScope,fixtures:unknown={}):OpenApiPlan|undefined{
  if(input===undefined||input===null){if(object(fixtures)&&Object.keys(fixtures).length)throw Error('OpenAPI fixtures require a document');return;}
  if(!object(input)||!object(input.paths)||Object.keys(input.paths).length>500)throw Error('OpenAPI paths must contain at most 500 entries');
  if(!scope.seeds[0])throw Error('OpenAPI discovery needs a scope seed');
  if(!object(fixtures)||Object.keys(fixtures).length>500)throw Error('OpenAPI fixtures must map paths to parameter sets');
  for(const [route,sets] of Object.entries(fixtures)){
    if(!Object.hasOwn(input.paths,route)||!Array.isArray(sets)||!sets.length||sets.length>10||sets.some(v=>!object(v)||Object.entries(v).some(([k,x])=>!k||typeof x!=='string'||!x||x.length>128||!/^[-a-zA-Z0-9_.]+$/.test(x)||['.','..'].includes(x))))throw Error('Use up to ten explicit synthetic path-parameter sets per OpenAPI path; values must be simple path segments');
  }
  const operations:ApiOperationPlan[]=[],seeds=new Set<string>();
  for(const [route,item] of Object.entries(input.paths)){
    const methods=object(item)?['get','put','post','delete','options','head','patch','trace'].filter(m=>Object.hasOwn(item,m)):[];
    if(!methods.length){operations.push({path:route,method:'—',urls:[],reason:'No inline operations; path references are not resolved'});continue;}
    for(const method of methods){
      const entry:ApiOperationPlan={path:route,method:method.toUpperCase(),urls:[]};operations.push(entry);
      if(method!=='get'){entry.reason='Automatic discovery supports GET only; configure other methods in explicit browser flows';continue;}
      if(!route.startsWith('/')||route.startsWith('//')||/[?#%\\]/.test(route)||!object(item)||!object(item.get)||item.$ref||item.get.$ref){entry.reason='Unsupported path or unresolved reference';continue;}
      const names=[...route.matchAll(/\{([^{}]+)\}/g)].map(m=>m[1]!);
      if(/[{}]/.test(route.replace(/\{[^{}]+\}/g,''))){entry.reason='Invalid path template';continue;}
      const params=new Map<string,Record<string,any>>();let invalid=false;
      for(const list of [item.parameters??[],item.get.parameters??[]]){
        if(!Array.isArray(list)){invalid=true;continue;}
        for(const p of list){if(!object(p)||p.$ref||typeof p.name!=='string'||typeof p.in!=='string'){invalid=true;continue;}params.set(p.in+'\n'+p.name,p);}
      }
      if(invalid){entry.reason='Unresolved or invalid parameters';continue;}
      if([...params.values()].some(p=>p.required===true&&p.in!=='path')||item.get.requestBody){entry.reason='Required non-path input or request body needs an explicit flow';continue;}
      if(names.some(n=>params.get('path\n'+n)?.required!==true)){entry.reason='Template has no required path-parameter declaration';continue;}
      const sets=names.length?fixtures[route]:[{}];
      if(!sets){entry.reason='Missing explicit test values for path parameters';continue;}
      if(sets.some((set:Record<string,string>)=>names.some(n=>!Object.hasOwn(set,n))||Object.keys(set).some(n=>!names.includes(n))))throw Error('Fixture parameter names must exactly match the route template');
      let excluded=0;
      for(const set of sets){
        const resolved=route.replace(/\{([^{}]+)\}/g,(_,name)=>set[name]);
        const url=new URL(resolved,scope.seeds[0]);
        if(url.pathname!==resolved||!inScope(scope,url.href)){excluded++;continue;}
        if(seeds.size>=500&&!seeds.has(url.href)){entry.reason='Generated route limit reached (500)';break;}
        seeds.add(url.href);entry.urls.push(url.href);
      }
      entry.urls=[...new Set(entry.urls)];
      if(excluded&&!entry.reason)entry.reason=excluded+' resolved test paths excluded by scope or path validation';
      if(!entry.urls.length&&!entry.reason)entry.reason='Resolved paths are outside scope or excluded';
    }
  }
  return {operations,seeds:[...seeds]};
}
