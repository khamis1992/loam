import { createHash } from "node:crypto";
import type { PentestFinding } from "../tools/pentest.js";

export interface SecurityFinding extends PentestFinding {
  fingerprint: string; requestIds: string[]; confidence: "observed" | "review";
  browserEvidenceIds?: string[];
  workflow: { state: "open" | "reviewing" | "accepted"; owner: string; note: string };
}
export interface RetestComparison { baselineId: string; new: string[]; persistent: string[]; notObserved: string[]; unverified: string[] }
export const coverageKey = (target: string, check: string) => `${target}\n${check}`;
export function enrichFinding(f: PentestFinding, requestIds: string[] = []): SecurityFinding {
  const fingerprint=createHash("sha256").update(`${f.check}\n${f.target}\n${f.title}`).digest("hex").slice(0,24);
  return {...f,id:fingerprint,fingerprint,requestIds,confidence:f.check.startsWith("source_")||f.check.startsWith("anonymous_api_")||["access_review","csrf_review","weak_csp","browser_framing"].includes(f.check)||["browser_csrf_review","browser_weak_csp"].includes(f.check)?"review":"observed",workflow:{state:"open",owner:"",note:""}};
}
export function compareFindings(baselineId: string, previous: SecurityFinding[], current: SecurityFinding[], covered: string[]): RetestComparison {
  const before=previous.filter(f=>f.verdict==="finding"),now=current.filter(f=>f.verdict==="finding");
  const ids=new Set(now.map(f=>f.fingerprint)),old=new Set(before.map(f=>f.fingerprint)),coverage=new Set(covered);
  return {baselineId,new:now.filter(f=>!old.has(f.fingerprint)).map(f=>f.fingerprint),persistent:now.filter(f=>old.has(f.fingerprint)).map(f=>f.fingerprint),notObserved:before.filter(f=>!ids.has(f.fingerprint)&&coverage.has(coverageKey(f.target,f.check))).map(f=>f.fingerprint),unverified:before.filter(f=>!ids.has(f.fingerprint)&&!coverage.has(coverageKey(f.target,f.check))).map(f=>f.fingerprint)};
}
export function sarif(findings: SecurityFinding[]) {
  const actual=findings.filter(f=>f.verdict==="finding");
  const rules=[...new Set(actual.map(f=>f.check))].map(id=>({id,shortDescription:{text:id}}));
  return {version:"2.1.0",$schema:"https://json.schemastore.org/sarif-2.1.0.json",runs:[{tool:{driver:{name:"Loam Security",rules}},invocations:[{executionSuccessful:!findings.some(f=>f.verdict==="error"),toolExecutionNotifications:findings.filter(f=>f.verdict==="error").map(f=>({level:"warning",descriptor:{id:f.check},message:{text:f.title+"\n"+f.detail}}))}],results:actual.map(f=>({ruleId:f.check,ruleIndex:rules.findIndex(r=>r.id===f.check),level:["high","critical"].includes(f.severity)?"error":f.severity==="info"?"note":"warning",message:{text:`${f.title}\n${f.detail}\n${f.remediation??""}`},...sourceLocation(f),partialFingerprints:{loamFingerprint:f.fingerprint},properties:{target:f.target,severity:f.severity,confidence:f.confidence,workflow:f.workflow,evidence:f.requestIds,browserEvidence:f.browserEvidenceIds??[]}}))}]};
}

function sourceLocation(f:SecurityFinding){
  if(!f.check.startsWith('source_'))return {};
  const match=/^(.*):(\d+)$/.exec(f.target);if(!match)return {};
  const file=match[1]!.replace(/\\/g,'/'),line=Number(match[2]);
  // Only workspace-relative source locations; never reinterpret network targets,
  // absolute paths or traversal as local file links in a downstream viewer.
  const parts=file.split('/');
  if(!Number.isSafeInteger(line)||line<1||!file||file.startsWith('/')||/[:\x00-\x1f\x7f]/.test(file)||parts.some(p=>!p||p==='.'||p==='..'))return {};
  let uri:string;try{uri=parts.map(p=>encodeURIComponent(p)).join('/');}catch{return {};}
  return {locations:[{physicalLocation:{artifactLocation:{uri,uriBaseId:'SRCROOT'},region:{startLine:line}}}]};
}
