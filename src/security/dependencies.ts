import fs from "node:fs";
import { taskPath } from "../server/taskWorkspace.js";
import type { PentestFinding } from "../tools/pentest.js";
import {appendPythonRequirements,pythonExactVersion,pythonPackageName} from './python-dependencies.js';

export interface DependencyInventory { packages: Array<{ name: string; version: string; dev: boolean; location?:string; installedName?:string;ecosystem?:'npm'|'PyPI' }>; findings: PentestFinding[]; warnings: string[]; coverage?:{complete:boolean;entries:number;processed:number;invalid:number;limitReached:boolean}; advisories?: { provider: "OSV"; checkedAt: string; queried: number; requests?:number; completed?:number; complete: boolean; matches: Array<{ name: string; version: string; ids: string[];ecosystem?:'npm'|'PyPI' }> } }
function inspectNpmDependencies(root: string): DependencyInventory {
  const result: DependencyInventory = { packages: [], findings: [], warnings: [] };
  const coverage:NonNullable<DependencyInventory['coverage']>=result.coverage={complete:true,entries:0,processed:0,invalid:0,limitReached:false};
  const incomplete=(reason:string)=>{coverage.complete=false;result.warnings.push(reason);result.findings.push({id:'dependency-coverage',check:'dependency_coverage',verdict:'error',severity:'info',target:'package-lock.json',title:'Dependency inventory incomplete',detail:reason});return result;};
  const file=taskPath(root,"package-lock.json");
  if (!fs.existsSync(file)) return incomplete("No package-lock.json in the task root; dependency inventory skipped");
  if(fs.statSync(file).size>10_000_000)return incomplete("Lockfile exceeds 10 MB limit");
  let lock: {packages?:Record<string,{name?:unknown;version?:unknown;dev?:boolean;resolved?:unknown;integrity?:unknown;link?:boolean}>};
  try { lock=JSON.parse(fs.readFileSync(file,"utf8")); } catch {return incomplete("Invalid or unreadable package-lock.json");}
  if(!lock?.packages || typeof lock.packages!=="object"||Array.isArray(lock.packages))return incomplete("Only npm lockfile packages format (v2/v3) is supported");
  coverage.entries=Object.keys(lock.packages).length;
  for(const [location,pkg] of Object.entries(lock.packages).slice(0,10000)) {
    coverage.processed++;
    if(!location)continue;
    if(!pkg||typeof pkg!=='object'||Array.isArray(pkg)){coverage.invalid++;continue;}
    if(pkg.link===true)continue;
    if(typeof pkg.version!=="string"||!pkg.version){coverage.invalid++;continue;}
    const installedName=location.split("node_modules/").at(-1)!;
    const name=pkg.name===undefined?installedName:pkg.name;
    if(typeof name!=='string'||!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)){coverage.invalid++;continue;}
    result.packages.push({name,version:pkg.version,dev:pkg.dev===true,location,installedName});
    const add=(check:string,severity:"medium"|"low",title:string,detail:string,remediation:string)=>result.findings.push({id:`dependency-${result.findings.length+1}`,check,verdict:"finding",severity,title,target:`package-lock.json#${location}`,detail,remediation});
    if(typeof pkg.resolved==="string" && pkg.resolved.startsWith("http://"))add("dependency_transport","medium","Dependency uses unencrypted download",`${name}@${pkg.version} resolves over HTTP. URL and credentials are omitted.`,"Use HTTPS registry URLs and regenerate the lockfile.");
    if(typeof pkg.resolved==="string" && /^https?:/.test(pkg.resolved) && !pkg.integrity && !pkg.link)add("dependency_integrity","low","Dependency archive lacks an integrity hash",`${name}@${pkg.version} has no lockfile integrity hash.`,"Regenerate the lockfile with a supported package manager and verify package provenance.");
  }
  if(coverage.entries>10000){coverage.limitReached=true;incomplete("Inventory truncated to 10000 lockfile entries");}
  if(coverage.invalid)incomplete(`${coverage.invalid} lockfile entries could not be inventoried`);
  result.warnings.push("Inventory checks transport and integrity only; no CVE database lookup was performed.");
  return result;
}

export function inspectDependencies(root:string):DependencyInventory{
  const present=(name:string)=>{try{return fs.existsSync(taskPath(root,name));}catch{return true;}};
  const pythonFiles=['requirements.txt','requirements-dev.txt'].filter(present);
  const npm=present('package-lock.json')||present('package.json');
  const result:DependencyInventory=npm||!pythonFiles.length?inspectNpmDependencies(root):{packages:[],findings:[],warnings:[],coverage:{complete:true,entries:0,processed:0,invalid:0,limitReached:false}};
  for(const file of pythonFiles)appendPythonRequirements(root,result,file,file==='requirements-dev.txt');
  for(const file of ['pyproject.toml','poetry.lock','Pipfile.lock','uv.lock'].filter(present)){
    result.coverage!.complete=false;result.warnings.push(file+': dependency declarations or lock format not yet supported');
    result.findings.push({id:'python-format-'+file,check:'dependency_coverage',verdict:'error',severity:'info',target:file,title:'Python dependency format not assessed',detail:'This file may declare additional dependencies or resolution details. requirements files do not establish coverage of this format.'});
  }
  const versions=new Map<string,Set<string>>();for(const p of result.packages.filter(p=>p.ecosystem==='PyPI')){const values=versions.get(p.name)??new Set<string>();values.add(p.version);versions.set(p.name,values);}
  if([...versions.values()].some(v=>v.size>1)){
    result.coverage!.complete=false;result.warnings.push('Conflicting Python version pins were retained as declarations; environment resolution is unverified.');
    result.findings.push({id:'python-conflict',check:'dependency_coverage',verdict:'error',severity:'info',target:'requirements.txt',title:'Conflicting Python version declarations',detail:'At least one normalized package name has multiple exact versions; no installed version is inferred.'});
  }
  return result;
}

/** Explicit opt-in: only dependency name/version metadata is sent, never source or auth. */
export async function queryAdvisories(inventory: DependencyInventory, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<void> {
  const unique=[...new Map(inventory.packages.map(p=>[(p.ecosystem??'npm')+':'+p.name+"@"+p.version,p])).values()];
  const packages=unique.filter(p=>p.ecosystem==='PyPI'?pythonPackageName(p.name)&&pythonExactVersion(p.version):(p.ecosystem===undefined||p.ecosystem==='npm')&&/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(p.name)&&/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(p.version)).slice(0,1000);
  const audit=inventory.advisories={provider:"OSV" as const,checkedAt:new Date().toISOString(),queried:0,requests:0,completed:0,complete:inventory.coverage?.complete!==false&&packages.length===unique.length,matches:[] as Array<{name:string;version:string;ids:string[];ecosystem?:'npm'|'PyPI'}>};
  inventory.warnings=inventory.warnings.filter(w=>!w.includes("no CVE database"));
  if(packages.length<unique.length)inventory.warnings.push("Advisory lookup limited to 1000 unique npm/PyPI packages with supported exact versions; other entries were not queried.");
  try {
    let totalBytes=0;
    for(let offset=0;offset<packages.length;offset+=100){
      let pending=packages.slice(offset,offset+100).map(p=>({p,token:undefined as string|undefined,tokens:new Set<string>(),pages:0}));
      while(pending.length){
      signal.throwIfAborted();if(audit.requests>=50)throw new Error('OSV request limit reached');audit.requests++;
      const batch=pending;
      const response=await fetcher("https://api.osv.dev/v1/querybatch",{method:"POST",redirect:"error",headers:{"content-type":"application/json"},signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),body:JSON.stringify({queries:batch.map(({p,token})=>({package:{name:p.name,ecosystem:p.ecosystem??"npm"},version:p.version,...(token?{page_token:token}:{})}))})});
      if(!response.ok)throw new Error("OSV returned HTTP "+response.status);
      const reader=response.body?.getReader();let bytes=0;const chunks:Uint8Array[]=[];
      if(reader)try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;totalBytes+=value.length;if(bytes>2_000_000||totalBytes>20_000_000)throw new Error("OSV response exceeded size limit");chunks.push(value);}}finally{await reader.cancel();}
      const data=JSON.parse(Buffer.concat(chunks).toString("utf8")) as {results?:Array<{vulns?:Array<{id?:unknown}>;next_page_token?:string}>};
      if(!Array.isArray(data.results)||data.results.length!==batch.length)throw new Error("Invalid OSV batch response");
      pending=[];
      for(const [i,item] of data.results.entries()){
        if(!item||typeof item!=="object"||Array.isArray(item))throw new Error("Invalid OSV result");
        if(item.vulns!==undefined&&(!Array.isArray(item.vulns)||item.vulns.some(v=>!v||typeof v!=='object'||typeof v.id!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(v.id))))throw new Error('Invalid OSV vulnerability identifiers');
        if(item.next_page_token!==undefined&&(typeof item.next_page_token!=='string'||!item.next_page_token))throw new Error('Invalid OSV pagination token');
        const job=batch[i]!,p=job.p;const ids=[...new Set((item.vulns??[]).map(v=>v.id as string))];
        if(!job.pages)audit.queried++;job.pages++;
        const previous=audit.matches.find(m=>m.name===p.name&&m.version===p.version&&(m.ecosystem??'npm')===(p.ecosystem??'npm'));
        const merged=[...new Set([...(previous?.ids??[]),...ids])];
        if(merged.length>10000)throw new Error('OSV advisory identifier limit reached');
        if(merged.length){if(previous)previous.ids=merged;else audit.matches.push({name:p.name,version:p.version,ids:merged,...(p.ecosystem==='PyPI'?{ecosystem:'PyPI' as const}:{})});}
        if(item.next_page_token){
          const token=item.next_page_token;
          if(token.length>4096||job.tokens.has(token)||job.pages>=10)throw new Error('OSV pagination limit or repeated token');
          job.tokens.add(token);job.token=token;pending.push(job);
        }else audit.completed++;
      }
      }
    }
  }catch(error){
    audit.complete=false;inventory.warnings.push("Advisory lookup incomplete: "+(signal.aborted?'cancelled':error instanceof Error?error.message:String(error)));
  }
  for(const [i,p] of audit.matches.entries())inventory.findings.push({id:'osv-'+(i+1),check:'dependency_advisory',verdict:'finding',severity:'info',target:(p.ecosystem??'npm')+':'+p.name+'@'+p.version,title:p.ecosystem==='PyPI'?'Known advisories match a declared Python dependency':'Known advisories match a locked dependency',detail:p.name+'@'+p.version+': '+p.ids.join(', ')+'. OSV batch returns advisory identifiers, not severity. Runtime reachability has not been assessed.',remediation:'Review the advisory at https://osv.dev/vulnerability/'+p.ids[0]+' and upgrade to a fixed compatible version; test affected functionality.'});
  if(!audit.complete)inventory.findings.push({id:"osv-error",check:"dependency_advisory",verdict:"error",severity:"info",target:"package-lock.json",title:"Dependency advisory lookup incomplete",detail:"Inventory, query eligibility, pagination or provider response was incomplete. "+(inventory.warnings.at(-1)??'Review inventory coverage.')});
  signal.throwIfAborted();
}
