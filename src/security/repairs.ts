import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import ts from 'typescript';
import {taskPath} from '../server/taskWorkspace.js';import {AssessmentError,readAssessment,assessmentActive} from './assessments.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export interface RepairDraft {id:string;createdAt:string;runId:string;fingerprint:string;file:string;line:number;baseHash:string;afterHash:string;edit:{start:number;end:number;before:string;after:string};state:'draft'|'applied'|'rolled_back'|'conflict';pending?:'apply'|'rollback';recovery?:string;warning:string}
function candidate(root:string,runId:string,fingerprint:string){
  const run=readAssessment(root,runId);if(run.status==='running')throw new AssessmentError('Wait for assessment completion',409);
  const finding=run.findings.find(f=>f.fingerprint===fingerprint&&f.check==='source_html');if(!finding)throw new AssessmentError('No supported source finding',404);
  const location=/^(.*):(\d+)$/.exec(finding.target);if(!location)throw new AssessmentError('Missing source location');
  const file=location[1]!,line=Number(location[2]);if(!/\.(?:[cm]?js|tsx?)$/.test(file))throw new AssessmentError('Repair supports JavaScript/TypeScript only');
  const full=taskPath(root,file);if(fs.statSync(full).size>300000)throw new AssessmentError('Source exceeds repair size limit');
  const bytes=fs.readFileSync(full),source=bytes.toString('utf8');if(!bytes.equals(Buffer.from(source,'utf8')))throw new AssessmentError('Repair requires valid UTF-8 source');if(!run.scan?.sourceHashes?.[file]||hash(source)!==run.scan.sourceHashes[file])throw new AssessmentError('Source changed or has no scanned hash; rescan before preparing a repair',409);
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);if((ast as any).parseDiagnostics?.length)throw new AssessmentError('Source has syntax errors; repair unavailable');
  const matches:Array<{node:ts.Identifier;after:string;supported:boolean}>=[];
  const visit=(n:ts.Node)=>{
    if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(n.left)&&ts.isIdentifier(n.left.name)&&n.left.name.text==='innerHTML'&&ast.getLineAndCharacterOfPosition(n.left.getStart(ast)).line+1===line)matches.push({node:n.left.name,after:'textContent',supported:true});
    if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&ts.isIdentifier(n.expression.name)&&n.expression.name.text==='insertAdjacentHTML'&&ast.getLineAndCharacterOfPosition(n.expression.getStart(ast)).line+1===line){
      const position=n.arguments[0];
      matches.push({node:n.expression.name,after:'insertAdjacentText',supported:!n.questionDotToken&&!n.expression.questionDotToken&&n.arguments.length===2&&!n.arguments.some(ts.isSpreadElement)&&!!position&&ts.isStringLiteral(position)&&['beforebegin','afterbegin','beforeend','afterend'].includes(position.text.toLowerCase())});
    }
    ts.forEachChild(n,visit);
  };visit(ast);
  if(matches.length!==1||!matches[0]!.supported)throw new AssessmentError('Source location is ambiguous or is not a supported direct HTML operation');
  const {node,after:replacement}=matches[0]!,edit={start:node.getStart(ast),end:node.end,before:node.text,after:replacement};
  const after=source.slice(0,edit.start)+edit.after+source.slice(edit.end);
  return {full,source,after,file,line,edit,baseHash:hash(source),afterHash:hash(after)};
}
function storage(root:string,id:string,suffix='.json'){if(!/^[a-f0-9-]{36}$/.test(id))throw new AssessmentError('Invalid repair id');return taskPath(root,'.loam/security/repairs/'+id+suffix);}
function durableWrite(file:string,content:string,mode=0o600){const fd=fs.openSync(file,'wx',mode);try{fs.writeFileSync(fd,content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function persist(root:string,d:RepairDraft){
  const destination=storage(root,d.id),tmp=storage(root,d.id,'.'+randomUUID()+'.tmp');
  try{durableWrite(tmp,JSON.stringify(d,null,2));fs.renameSync(tmp,destination);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
export function prepareRepair(root:string,runId:string,input:any):RepairDraft{
  if(typeof input?.fingerprint!=='string')throw new AssessmentError('Finding fingerprint required');
  const c=candidate(root,runId,input.fingerprint);
  const draft:RepairDraft={id:randomUUID(),createdAt:new Date().toISOString(),runId,fingerprint:input.fingerprint,file:c.file,line:c.line,baseHash:c.baseHash,afterHash:c.afterHash,edit:c.edit,state:'draft',warning:'Converts HTML rendering to plain text. Review intended formatting and run functional tests. This is a repair proposal for a static indicator, not proof of a vulnerability or a verified fix.'};
  const destination=storage(root,draft.id);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(draft,null,2),{flag:'wx',mode:0o600});return draft;
}
function read(root:string,runId:string,id:string):RepairDraft{
  readAssessment(root,runId);const p=storage(root,id);if(!fs.existsSync(p))throw new AssessmentError('Repair not found',404);
  const d=JSON.parse(fs.readFileSync(p,'utf8')) as RepairDraft;if(d.id!==id||d.runId!==runId)throw new AssessmentError('Repair does not belong to this assessment',404);
  if(d.pending){
    try{
      if(hash(fs.readFileSync(storage(root,id,'.before'),'utf8'))!==d.baseHash)throw Error('backup');
      const current=hash(fs.readFileSync(taskPath(root,d.file),'utf8'));
      if(current!==d.baseHash&&current!==d.afterHash)throw Error('source');
      d.state=d.pending==='apply'?(current===d.afterHash?'applied':'draft'):(current===d.baseHash?'rolled_back':'applied');
      delete d.pending;d.recovery='Recovered interrupted operation from source and backup hashes';
    }catch{d.state='conflict';d.recovery='Interrupted repair conflicts with current source or backup; no source was overwritten';}
    persist(root,d);
  }
  return d;
}
function replace(root:string,file:string,expected:string,content:string){
  const destination=taskPath(root,file);if(hash(fs.readFileSync(destination,'utf8'))!==expected)throw new AssessmentError('Source changed; repair was not applied',409);
  const tmp=taskPath(root,path.join(path.dirname(file),'.loam-repair-'+randomUUID()+'.tmp'));
  try{durableWrite(tmp,content,fs.statSync(destination).mode);if(hash(fs.readFileSync(destination,'utf8'))!==expected)throw new AssessmentError('Concurrent source edit detected',409);fs.renameSync(tmp,destination);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
export function changeRepair(root:string,runId:string,id:string,input:any,rollback=false):RepairDraft{
  if(input?.reviewed!==true)throw new AssessmentError('Explicit repair review is required');
  if(assessmentActive(root))throw new AssessmentError('An active assessment prevents source changes; finish or cancel it first',409);
  const d=read(root,runId,id);
  if(rollback){
    if(d.state!=='applied')throw new AssessmentError('Only applied repairs can be rolled back',409);
    const original=fs.readFileSync(storage(root,id,'.before'),'utf8');if(hash(original)!==d.baseHash)throw new AssessmentError('Repair backup integrity mismatch',409);
    d.pending='rollback';persist(root,d);replace(root,d.file,d.afterHash,original);d.state='rolled_back';
  }else{
    if(d.state!=='draft')throw new AssessmentError('Repair is not an unapplied draft',409);
    const c=candidate(root,runId,d.fingerprint);if(c.file!==d.file||c.baseHash!==d.baseHash||c.afterHash!==d.afterHash||JSON.stringify(c.edit)!==JSON.stringify(d.edit))throw new AssessmentError('Repair draft integrity mismatch',409);
    const backup=storage(root,id,'.before');if(fs.existsSync(backup)){if(hash(fs.readFileSync(backup,'utf8'))!==d.baseHash)throw new AssessmentError('Repair backup integrity mismatch',409);}else durableWrite(backup,c.source);
    d.pending='apply';persist(root,d);replace(root,d.file,d.baseHash,c.after);d.state='applied';
  }
  delete d.pending;delete d.recovery;persist(root,d);return d;
}
export function listRepairs(root:string,runId:string):RepairDraft[]{
  readAssessment(root,runId);const dir=taskPath(root,'.loam/security/repairs');if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name=>{try{return [read(root,runId,name.slice(0,-5))];}catch{return [];}}).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(-200);
}
