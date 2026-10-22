import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {analyzeSqlSource} from '../security/source-sql.js';
import {analyzeNoSqlSource} from '../security/source-nosql.js';
import {SECURITY_CAPABILITIES} from '../security/diagnostics.js';

// External source is parsed as data only: never imported, transpiled or executed.
const root=path.resolve(process.argv[2]??'output/verification/codeql-sql-corpus');
const output=path.resolve(process.argv[3]??'output/verification/security-sql-benchmark.json');
const mode=process.argv[4]??'sql';assert.ok(['sql','database'].includes(mode),'Use sql or database mode');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8').replace(/^\uFEFF/,''));
assert.equal(manifest.revision,'ff3231c5ac4779befd8c8690bb04f447fc6a8d13');
for(const [name,hash] of Object.entries(manifest.files)){
  assert.equal(path.basename(name),name);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex'),hash,`Corpus changed: ${name}`);
}
type Sink={file:string;line:number;column:number;endLine:number;endColumn:number};
const sinks:Sink[]=[];let selected=false;
for(const row of fs.readFileSync(path.join(root,'SqlInjection.expected'),'utf8').split(/\r?\n/)){
  if(['edges','nodes','subpaths'].includes(row)){selected=false;continue;}
  if(row.startsWith('#')){selected=row==='#select';continue;}
  if(!selected||!row.trim())continue;
  const m=/^\| ([^:|]+):(\d+):(\d+):(\d+):(\d+) \|/.exec(row);
  assert.ok(m,`Unrecognized expected row: ${row.slice(0,100)}`);
  const sink={file:m[1]!,line:+m[2]!,column:+m[3]!,endLine:+m[4]!,endColumn:+m[5]!};
  if(!sinks.some(s=>JSON.stringify(s)===JSON.stringify(sink)))sinks.push(sink);
}
assert.ok(sinks.length>0);
const files=Object.keys(manifest.files).filter(name=>/\.[cm]?[jt]sx?$/.test(name)).sort();
const rows=files.map(file=>{
  const source=fs.readFileSync(path.join(root,file),'utf8');
  const result=analyzeSqlSource(file,source),nosql=mode==='database'?analyzeNoSqlSource(file,source):undefined,ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const risks=[...result.risks,...(nosql?.risks??[])];
  const calls:Array<{line:number;start:number;end:number}>=[];
  const visit=(node:ts.Node)=>{if(ts.isCallExpression(node))calls.push({line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,start:node.getStart(ast),end:node.end});ts.forEachChild(node,visit);};visit(ast);
  const expected=sinks.filter(s=>s.file===file);
  const matches=(line:number,s:Sink)=>{
    const start=ast.getPositionOfLineAndCharacter(s.line-1,s.column-1),end=ast.getPositionOfLineAndCharacter(s.endLine-1,s.endColumn);
    return calls.some(c=>c.line===line&&c.start<=start&&c.end>=end);
  };
  const matched=expected.filter(s=>risks.some(r=>matches(r.line,s)));
  return {file,status:result.status,nosqlStatus:nosql?.status,expected:expected.length,matched:matched.length,
    missed:expected.filter(s=>!matched.includes(s)),
    unmatchedCandidateLines:risks.filter(r=>!expected.some(s=>matches(r.line,s))).map(r=>r.line)};
});
assert.ok(sinks.every(s=>files.includes(s.file)),'Expected sink file absent from corpus');
const report={createdAt:new Date().toISOString(),mode,engineRevision:SECURITY_CAPABILITIES.revision,corpus:manifest,
  methodology:'Location overlap: CodeQL expected sink range inside a call starting on a Loam candidate line. Not CodeQL execution, precision measurement, independent audit or production vulnerability confirmation. No expected sinks excluded.',
  expectedSinks:sinks.length,matchedSinks:rows.reduce((n,r)=>n+r.matched,0),unmatchedCandidates:rows.reduce((n,r)=>n+r.unmatchedCandidateLines.length,0),files:rows};
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,files:files.length,expected:report.expectedSinks,matched:report.matchedSinks,unmatchedCandidates:report.unmatchedCandidates}));
