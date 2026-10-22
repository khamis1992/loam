import fs from 'node:fs';
import {taskPath} from '../server/taskWorkspace.js';
import type {DependencyInventory} from './dependencies.js';

export const pythonExactVersion=(v:string)=>v.length<=100&&/^(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*(?:(?:a|b|rc)[0-9]+)?(?:\.post[0-9]+)?(?:\.dev[0-9]+)?$/.test(v);
export const pythonPackageName=(v:string)=>v.length<=200&&/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(v);
export const normalizePythonName=(v:string)=>v.toLowerCase().replace(/[-_.]+/g,'-');

export function appendPythonRequirements(root:string,result:DependencyInventory,file:string,dev:boolean){
  const coverage=result.coverage!;
  const incomplete=(reason:string)=>{coverage.complete=false;result.warnings.push(file+': '+reason);result.findings.push({id:'python-coverage-'+result.findings.length,check:'dependency_coverage',verdict:'error',severity:'info',target:file,title:'Python requirements inventory incomplete',detail:reason});};
  let source:string;
  try{
    const full=taskPath(root,file);if(fs.statSync(full).size>1_000_000){incomplete('Requirements file exceeds 1 MB');return;}
    const bytes=fs.readFileSync(full);source=bytes.toString('utf8');if(!bytes.equals(Buffer.from(source))){incomplete('Requirements file is not valid UTF-8');return;}
  }catch{incomplete('Requirements file could not be read safely');return;}
  const entries=source.replace(/^\uFEFF/,'').split(/\r?\n/).map((text,i)=>({text:text.trim(),line:i+1})).filter(v=>v.text&&!v.text.startsWith('#'));
  coverage.entries+=entries.length;
  const available=Math.max(0,10000-coverage.processed),selected=entries.slice(0,available);
  let invalid=0;const invalidLines:number[]=[];
  for(const {text,line} of selected){
    coverage.processed++;
    // URL, index, include, marker, extras, continuation and range syntax is never executed or resolved.
    const match=/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^\s#;]+)(?:\s+#.*)?$/.exec(text);
    if(!match||!pythonPackageName(match[1]!)||!pythonExactVersion(match[2]!)){
      coverage.invalid++;invalid++;if(invalidLines.length<20)invalidLines.push(line);continue;
    }
    result.packages.push({name:normalizePythonName(match[1]!),version:match[2]!,ecosystem:'PyPI',dev,location:file+':'+line});
  }
  if(selected.length<entries.length){coverage.limitReached=true;incomplete('Combined inventory stopped at 10000 entries');}
  if(invalid)incomplete(invalid+' unsupported or non-exact entries; line numbers: '+invalidLines.join(', ')+'. Values omitted.');
  result.warnings.push(file+': exact declared Python requirements only; installed state, transitive resolution and archive integrity were not verified.');
}
