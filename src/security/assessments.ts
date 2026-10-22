import fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { taskPath } from "../server/taskWorkspace.js";
import { PENTEST_CHECKS, validatePentestTarget, runPentestCheck, scanWorkspaceRoutesAndRisks, buildPentestMarkdownReport, type PentestFinding, type RouteAndRiskScan } from "../tools/pentest.js";
import { ScopeError, normalizeScope, normalizeAuth, scopedTransport, inScope, type CampaignScope, type RequestEvidence } from "./scope.js";
import { discover, inspectPage, type DiscoveryResult } from "./discovery.js";
import { inspectDependencies, queryAdvisories, type DependencyInventory } from "./dependencies.js";
import { enrichFinding, coverageKey, compareFindings, type SecurityFinding, type RetestComparison } from "./findings.js";
import { normalizeBrowserSecrets, normalizeBrowserOptions, blankBrowserOptions, runBrowserAssessment, type BrowserOptions, type BrowserResult } from "./browser.js";
import { normalizeBusinessCases, normalizeQuotaCases, normalizeStepCases, normalizePricingCases, normalizeCancelCases, normalizeRaceCases, normalizeConsistencyCases, normalizeBusinessSecrets, normalizeConsistencyValues, runBusinessCases, runQuotaCases, runStepCases, runPricingCases, runCancelCases, runRaceCases, runConsistencyCases, type BusinessCase, type QuotaCase, type StepCase, type PricingCase, type CancelCase, type RaceCase, type ConsistencyCase, type BusinessResult, type BusinessEngineInput } from "./business-logic.js";
import { normalizeInjectionCases, normalizeInjectionValues, runInjectionCases, type InjectionCase, type InjectionProof } from "./injection.js";
import { normalizeTraversalCases, normalizeTraversalValues, runTraversalCases, type TraversalCase, type TraversalProof } from "./path-traversal.js";
import { normalizeSsrfCases, normalizeSsrfValues, runSsrfCases, type SsrfCase, type SsrfProof } from "./ssrf.js";
import { normalizeUploadCases, normalizeUploadValues, runUploadCases, type UploadCase, type UploadProof } from "./upload.js";
import { normalizeTemplateCases, normalizeTemplateValues, runTemplateCases, type TemplateCase, type TemplateProof } from "./template-injection.js";
import { normalizeXxeCases, normalizeXxeValues, runXxeCases, type XxeCase, type XxeProof } from "./xxe.js";
import { normalizeDeserCases, normalizeDeserValues, runDeserCases, type DeserCase, type DeserProof } from "./deserialization.js";
import { normalizeCommandCases, normalizeCommandValues, runCommandCases, type CommandCase, type CommandProof } from "./command.js";
import { normalizeRedirectCases, normalizeRedirectValues, runRedirectCases, type RedirectCase, type RedirectProof } from "./redirect.js";
import { traceSourceFlows, linkFlowsToDynamicEvidence, type FlowScan } from "./source-flow.js";
import { buildPlan, type CampaignPlan } from "./planning.js";
import { executionDiagnostics } from './diagnostics.js';
import {planOpenApi,type OpenApiPlan} from './openapi.js';

export class AssessmentError extends Error { constructor(message: string, public status = 400) { super(message); } }
export interface AssessmentInput { target?: unknown; checks?: unknown; includeSource?: unknown; authorized?: unknown; profile?: unknown; scope?: unknown; auth?: unknown; openapi?: unknown; openapiFixtures?:unknown; protectedPaths?: unknown; includeDependencies?: unknown; queryAdvisories?: unknown; baselineId?: unknown; browser?:unknown; browserSecrets?:unknown; business?:unknown; businessSecrets?:unknown; businessQuotas?:unknown; businessSteps?:unknown; businessPricing?:unknown; businessCancels?:unknown; businessRaces?:unknown; businessConsistency?:unknown; injection?:unknown; traversal?:unknown; ssrf?:unknown; upload?:unknown; template?:unknown; xxe?:unknown; deser?:unknown; command?:unknown; redirect?:unknown }
export interface Assessment {
  id: string; target: string; checks: string[]; includeSource: boolean;
  status: "running" | "completed" | "cancelled" | "failed" | "interrupted" | "partial";
  createdAt: string; finishedAt?: string; completed: number; total: number;
  findings: SecurityFinding[]; scan?: RouteAndRiskScan; error?: string;
  events: Array<{ at: string; message: string }>;
  revision: number; profile: "quick" | "campaign"; scope: CampaignScope;
  authenticated: boolean; includeDependencies: boolean; queryAdvisories: boolean; protectedPaths: string[]; apiSeeds: string[];
  evidence: RequestEvidence[]; discovery?: DiscoveryResult; inventory?: DependencyInventory;
  covered: string[]; comparison?: RetestComparison; baselineId?: string;
  browserOptions: BrowserOptions; browser?: BrowserResult;
  flowScan?: FlowScan;
  plan?: CampaignPlan;
  businessCases: BusinessCase[]; businessQuotas: QuotaCase[]; businessSteps: StepCase[]; businessPricing: PricingCase[]; businessCancels: CancelCase[]; businessRaces: RaceCase[]; businessConsistency: ConsistencyCase[]; injectionCases: InjectionCase[]; traversalCases: TraversalCase[]; ssrfCases: SsrfCase[]; uploadCases: UploadCase[]; templateCases: TemplateCase[]; xxeCases: XxeCase[]; deserCases: DeserCase[]; commandCases: CommandCase[]; redirectCases: RedirectCase[]; business?: BusinessResult; injection?: { proofs: InjectionProof[]; incomplete: boolean }; traversal?: { proofs: TraversalProof[]; incomplete: boolean }; ssrf?: { proofs: SsrfProof[]; incomplete: boolean }; upload?: { proofs: UploadProof[]; incomplete: boolean }; template?: { proofs: TemplateProof[]; incomplete: boolean }; xxe?: { proofs: XxeProof[]; incomplete: boolean }; deser?: { proofs: DeserProof[]; incomplete: boolean }; command?: { proofs: CommandProof[]; incomplete: boolean }; redirect?: { proofs: RedirectProof[]; incomplete: boolean };
  openapiPlan?:OpenApiPlan;
  diagnostics?: ReturnType<typeof executionDiagnostics>;
  witnesses?:{salt:string;digests:Record<string,string>};
}
const active = new Map<string, { run: Assessment; controller: AbortController }>();
export const assessmentActive=(root:string)=>active.has(root);
const folder = (root: string) => taskPath(root, ".loam/security");
const file = (root: string, id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new AssessmentError("Invalid assessment ID");
  return taskPath(root, ".loam/security/"+id+".json");
};
function save(root: string, run: Assessment) {
  fs.mkdirSync(folder(root), { recursive: true });
  const temp = taskPath(root, ".loam/security/"+randomUUID()+".tmp");
  try { fs.writeFileSync(temp, JSON.stringify(run)); fs.renameSync(temp, file(root, run.id)); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function readAssessment(root: string, id: string): Assessment {
  const live = active.get(root)?.run; if (live?.id === id) {live.diagnostics=executionDiagnostics(live);return live;}
  const location = file(root, id);
  if (!fs.existsSync(location)) throw new AssessmentError("Assessment not found", 404);
  const run = JSON.parse(fs.readFileSync(location, "utf8")) as Assessment;
  if (run.status === "running") { run.status = "interrupted"; run.error = "Server restarted before the assessment finished"; }
  run.revision ??= 0; run.profile ??= "quick"; run.evidence ??= []; run.covered ??= [];
  run.scope ??= normalizeScope(run.target, undefined);run.protectedPaths ??= [];run.apiSeeds ??= [];run.businessCases ??= [];run.businessQuotas ??= [];run.businessSteps ??= [];run.businessPricing ??= [];run.businessCancels ??= [];run.businessRaces ??= [];run.businessConsistency ??= [];run.injectionCases ??= [];run.traversalCases ??= [];run.ssrfCases ??= [];run.uploadCases ??= [];run.templateCases ??= [];run.xxeCases ??= [];run.deserCases ??= [];run.commandCases ??= [];run.redirectCases ??= [];
  run.browserOptions = {...blankBrowserOptions(),...run.browserOptions};
  run.findings = run.findings.map(f=>f.fingerprint?f:enrichFinding(f));
  run.diagnostics=executionDiagnostics(run);
  return run;
}
export function listAssessments(root: string) {
  if (!fs.existsSync(folder(root))) return [];
  return fs.readdirSync(folder(root)).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))
    .map(n => readAssessment(root, n.slice(0, -5)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
}
export function cancelAssessment(root: string, id: string) {
  const run = readAssessment(root, id);
  const live = active.get(root);
  if (live?.run.id === id) live.controller.abort();
  return run;
}
export function updateFinding(root:string,id:string,input:unknown) {
  const run=readAssessment(root,id);
  if(run.status==="running")throw new AssessmentError("Wait for the assessment to finish before triage",409);
  if(!input||typeof input!=="object")throw new AssessmentError("Invalid finding update");
  const p=input as Record<string,unknown>;
  if(p.expectedRevision!==run.revision)throw new AssessmentError("Report changed; reload before updating",409);
  if(!["open","reviewing","accepted"].includes(String(p.state))||typeof p.owner!=="string"||p.owner.length>120||typeof p.note!=="string"||p.note.length>2000)throw new AssessmentError("Invalid triage fields");
  const finding=run.findings.find(f=>f.fingerprint===p.fingerprint&&f.verdict==="finding");
  if(!finding)throw new AssessmentError("Finding not found",404);
  finding.workflow={state:p.state as SecurityFinding["workflow"]["state"],owner:p.owner,note:p.note};run.revision++;
  run.events.push({at:new Date().toISOString(),message:"Finding "+finding.fingerprint+": "+finding.workflow.state});save(root,run);return run;
}
export function assessmentReport(root: string, id: string) {
  const run = readAssessment(root, id);
  const details=["Assessment: "+run.id,"Status: "+run.status,"Profile: "+run.profile,"Started: "+run.createdAt,"Finished: "+(run.finishedAt??"—"),"Completed: "+run.completed+"/"+run.total,"HTTP requests: "+run.evidence.length+"/"+run.scope.maxRequests,"Authenticated: "+(run.authenticated?"yes (credentials not stored)":"no")].join("\n");
  const scope="\n\n## Scope and coverage\n\n"+run.scope.seeds.map(s=>"- "+s).join("\n")+"\nExcluded paths: "+(run.scope.exclusions.join(", ")||"none")+"\nDiscovered pages: "+(run.discovery?.pages.length??0)+"\nStatic discovery and optional rendered DOM inspection; browser form submissions require explicitly allowlisted POST paths. JavaScript executes only when browser checks are enabled. Successful checks do not establish absence of vulnerabilities.\n";
  const comparison=run.comparison?"\n## Retest\n\n"+JSON.stringify(run.comparison,null,2)+"\nNot observed means only that the same check did not reproduce the observation; unverified items remain unresolved.\n":"";
  const triage="\n## Remediation tracking\n\n"+run.findings.filter(f=>f.verdict==="finding").map(f=>"- "+f.fingerprint+" | "+f.workflow.state+" | "+(f.workflow.owner||"unassigned")+" | "+f.workflow.note+"\n  Evidence: "+(f.requestIds.join(", ")||"source/transport inspection")).join("\n");
  const browser=run.browser?"\n\n## Browser verification\n\n"+JSON.stringify(run.browser,null,2)+"\nScreenshots mask inputs and supplied session values in text. Review artifacts as sensitive application evidence.\n":"";
  const business=run.business?"\n\n## Business logic verification\n\n"+JSON.stringify(run.business,null,2)+"\nEach case intentionally repeats the declared operation inside the approved scope; duplicates created by the test may persist, so plan test-data cleanup separately. A clean replay proves idempotency for the declared body only, not for every operation variant.\n":"";
  return details+"\n\n## Execution diagnostics\n\n"+JSON.stringify(executionDiagnostics(run),null,2)+scope.replace("No exploitation or JavaScript execution.",run.browserOptions.enabled?"Isolated browser rendering and selected non-destructive verification probes enabled.":"JavaScript execution disabled.")+comparison+buildPentestMarkdownReport({ target: run.target, workspace: root, findings: run.findings, scan: run.scan })+triage+browser+business+"\n\n## HTTP evidence (bodies and secrets omitted)\n\n"+JSON.stringify(run.evidence,null,2)+"\n";
}
export function retestAssessment(root:string,id:string,input:AssessmentInput) {
  const old=readAssessment(root,id);if(old.status==="running")throw new AssessmentError("Cannot retest an active run",409);
  if(old.queryAdvisories&&input.queryAdvisories!==true)throw new AssessmentError("Confirm OSV lookup to retest this baseline");
  return startAssessment(root,{target:old.target,checks:old.checks,includeSource:old.includeSource,includeDependencies:old.includeDependencies,queryAdvisories:old.queryAdvisories,profile:old.profile,scope:old.scope,protectedPaths:old.protectedPaths,auth:input.auth,authorized:input.authorized,baselineId:id,browser:old.browserOptions,browserSecrets:input.browserSecrets,business:old.businessCases,businessQuotas:old.businessQuotas,businessSteps:old.businessSteps,businessPricing:old.businessPricing,businessCancels:old.businessCancels,businessRaces:old.businessRaces,businessConsistency:old.businessConsistency,injection:old.injectionCases,traversal:old.traversalCases,ssrf:old.ssrfCases,upload:old.uploadCases,template:old.templateCases,xxe:old.xxeCases,deser:old.deserCases,command:old.commandCases,redirect:old.redirectCases,businessSecrets:input.businessSecrets},old.apiSeeds,old.openapiPlan);
}
export function startAssessment(root: string, input: AssessmentInput, priorApiSeeds?: string[],priorApiPlan?:OpenApiPlan) {
  if (active.has(root)) throw new AssessmentError("An assessment is already running in this workspace", 409);
  if (active.size >= 3) throw new AssessmentError("Assessment capacity reached; try again later", 429);
  let target = "",scope:CampaignScope,auth:Record<string,string>,seeds:string[],browserOptions:BrowserOptions,businessCases:BusinessCase[],businessQuotas:QuotaCase[],businessSteps:StepCase[],businessPricing:PricingCase[],businessCancels:CancelCase[],businessRaces:RaceCase[],businessConsistency:ConsistencyCase[],injectionCases:InjectionCase[],traversalCases:TraversalCase[],ssrfCases:SsrfCase[],uploadCases:UploadCase[],templateCases:TemplateCase[],xxeCases:XxeCase[],deserCases:DeserCase[],commandCases:CommandCase[],redirectCases:RedirectCase[];let browserSecrets:Record<string,string>={},businessSecrets:Record<string,string>={};
  const profile=input.profile??"quick";
  let openapiPlan:OpenApiPlan|undefined;
  if(profile!=="quick"&&profile!=="campaign")throw new AssessmentError("Unknown assessment profile");
  try {
    if (typeof input.target === "string" && input.target.trim()) target=validatePentestTarget(input.target.trim());
    scope=normalizeScope(target,input.scope);auth=normalizeAuth(input.auth,scope);openapiPlan=priorApiPlan??planOpenApi(input.openapi,scope,input.openapiFixtures);seeds=priorApiSeeds??openapiPlan?.seeds??[];
    if(openapiPlan&&profile!=='campaign')throw Error('OpenAPI discovery requires campaign mode');
    browserOptions=normalizeBrowserOptions(input.browser,scope);browserSecrets=normalizeBrowserSecrets(input.browserSecrets,browserOptions);
    businessCases=normalizeBusinessCases(input.business,scope,profile);businessQuotas=normalizeQuotaCases(input.businessQuotas,scope,profile);businessSteps=normalizeStepCases(input.businessSteps,scope,profile);businessPricing=normalizePricingCases(input.businessPricing,scope,profile);businessCancels=normalizeCancelCases(input.businessCancels,scope,profile);businessRaces=normalizeRaceCases(input.businessRaces,scope,profile);businessConsistency=normalizeConsistencyCases(input.businessConsistency,scope,profile);injectionCases=normalizeInjectionCases(input.injection,scope,profile,browserOptions.postPaths);traversalCases=normalizeTraversalCases(input.traversal,scope,profile);ssrfCases=normalizeSsrfCases(input.ssrf,scope,profile,browserOptions.postPaths);uploadCases=normalizeUploadCases(input.upload,scope,profile,browserOptions.postPaths);templateCases=normalizeTemplateCases(input.template,scope,profile,browserOptions.postPaths);xxeCases=normalizeXxeCases(input.xxe,scope,profile,browserOptions.postPaths);deserCases=normalizeDeserCases(input.deser,scope,profile,browserOptions.postPaths);commandCases=normalizeCommandCases(input.command,scope,profile,browserOptions.postPaths);redirectCases=normalizeRedirectCases(input.redirect,scope,profile);businessSecrets={...normalizeBusinessSecrets(input.businessSecrets,businessCases,businessQuotas,businessPricing,businessRaces,businessCancels.flatMap(c=>[{bodyRef:c.operationBodyRef},{bodyRef:c.cancelBodyRef}]),businessSteps.flatMap(c=>c.steps.map(s=>s.bodyRef).filter((b): b is string => !!b).map(bodyRef=>({bodyRef})))),...normalizeConsistencyValues(input.businessSecrets,businessConsistency),...normalizeInjectionValues(input.businessSecrets,injectionCases),...normalizeTraversalValues(input.businessSecrets,traversalCases),...normalizeSsrfValues(input.businessSecrets,ssrfCases),...normalizeUploadValues(input.businessSecrets,uploadCases),...normalizeTemplateValues(input.businessSecrets,templateCases),...normalizeXxeValues(input.businessSecrets,xxeCases),...normalizeDeserValues(input.businessSecrets,deserCases),...normalizeCommandValues(input.businessSecrets,commandCases),...normalizeRedirectValues(input.businessSecrets,redirectCases)};
    if(browserOptions.enabled&&browserOptions.accessAssertions.length&&!Object.keys(auth).length&&!browserOptions.login.length)throw Error("Browser access assertions require an authenticated positive control");
    if(scope.seeds.some(s=>!inScope(scope,s)))throw new Error("A seed is excluded or has an unsupported path");
  } catch(error) { throw new AssessmentError(error instanceof Error?error.message:String(error)); }
  if(scope.seeds.length&&input.authorized!==true)throw new AssessmentError("Confirm authorization for all scope seeds");
  target ||= scope.seeds[0]??"";
  const includeSource = input.includeSource === true,includeDependencies=input.includeDependencies===true;
  if(input.queryAdvisories===true&&!includeDependencies)throw new AssessmentError("Enable dependency inventory before advisory lookup");
  if (!target && !includeSource && !includeDependencies) throw new AssessmentError("Choose a target or enable workspace assessment");
  const checks = input.checks === undefined ? PENTEST_CHECKS.map(c => c.name) : input.checks;
  if (!Array.isArray(checks) || checks.length > 8 || checks.some(c => typeof c !== "string" || !PENTEST_CHECKS.some(known => known.name === c))) throw new AssessmentError("Invalid checks");
  if (target && !checks.length) throw new AssessmentError("Select at least one check");
  const protectedPaths=input.protectedPaths??[];
  const validProtected=(p:unknown)=>{try{return typeof p==="string"&&p.startsWith("/")&&!p.startsWith("//")&&!!target&&inScope(scope,new URL(p,target).href);}catch{return false;}};
  if(!Array.isArray(protectedPaths)||protectedPaths.length>20||protectedPaths.some(p=>!validProtected(p)))throw new AssessmentError("Protected paths must be within the approved scope (maximum 20)");
  if(protectedPaths.length&&!Object.keys(auth).length)throw new AssessmentError("Protected-route comparison requires authentication");
  let baseline:Assessment|undefined;
  if(input.baselineId!==undefined){
    if(typeof input.baselineId!=="string")throw new AssessmentError("Invalid baseline");
    baseline=readAssessment(root,input.baselineId);
    if(baseline.status==="running")throw new AssessmentError("Baseline is still running");
    if(Boolean(baseline.authenticated)!==Boolean(Object.keys(auth).length||browserOptions.login.length||browserOptions.accounts.length))throw new AssessmentError("Retest requires the same authentication mode; provide fresh credentials for authenticated baselines");
    if(JSON.stringify(browserOptions)!==JSON.stringify(baseline.browserOptions))throw new AssessmentError("Retest must preserve browser verification options");
    if(JSON.stringify(scope)!==JSON.stringify(baseline.scope)||profile!==baseline.profile||JSON.stringify(checks)!==JSON.stringify(baseline.checks)||JSON.stringify(protectedPaths)!==JSON.stringify(baseline.protectedPaths)||JSON.stringify(seeds)!==JSON.stringify(baseline.apiSeeds)||JSON.stringify(businessCases)!==JSON.stringify(baseline.businessCases??[])||JSON.stringify(businessQuotas)!==JSON.stringify(baseline.businessQuotas??[])||JSON.stringify(businessSteps)!==JSON.stringify(baseline.businessSteps??[])||JSON.stringify(businessPricing)!==JSON.stringify(baseline.businessPricing??[])||JSON.stringify(businessCancels)!==JSON.stringify(baseline.businessCancels??[])||JSON.stringify(businessRaces)!==JSON.stringify(baseline.businessRaces??[])||JSON.stringify(businessConsistency)!==JSON.stringify(baseline.businessConsistency??[])||JSON.stringify(injectionCases)!==JSON.stringify(baseline.injectionCases??[])||JSON.stringify(traversalCases)!==JSON.stringify(baseline.traversalCases??[])||JSON.stringify(ssrfCases)!==JSON.stringify(baseline.ssrfCases??[])||JSON.stringify(uploadCases)!==JSON.stringify(baseline.uploadCases??[])||JSON.stringify(templateCases)!==JSON.stringify(baseline.templateCases??[])||JSON.stringify(xxeCases)!==JSON.stringify(baseline.xxeCases??[])||JSON.stringify(deserCases)!==JSON.stringify(baseline.deserCases??[])||JSON.stringify(commandCases)!==JSON.stringify(baseline.commandCases??[])||JSON.stringify(redirectCases)!==JSON.stringify(baseline.redirectCases??[])||includeSource!==baseline.includeSource||includeDependencies!==Boolean(baseline.includeDependencies))throw new AssessmentError("Retest must preserve the baseline scope and checks");
  }
  const witnessRefs=[...new Set([...(browserOptions.anonymousApi??[]).flatMap(c=>c.publicKeyRef?[c.publicKeyRef]:[]),...browserOptions.accounts.map(a=>a.witness.textRef),...browserOptions.accounts.flatMap(a=>(a.apiCredentials??[]).map(c=>c.identityRef)),...browserOptions.authorization.filter(c=>c.kind==='api').map(c=>c.markerRef),...browserOptions.authorization.flatMap(c=>c.bodyRef?[c.bodyRef]:[]),...(browserOptions.csrf??[]).map(c=>c.bodyRef),...(browserOptions.xssStored??[]).map(c=>c.bodyRef),...businessCases.map(c=>c.bodyRef),...businessQuotas.map(c=>c.bodyRef),...businessPricing.map(c=>c.bodyRef),...businessRaces.map(c=>c.bodyRef),...businessConsistency.map(c=>c.valueRef),...injectionCases.map(c=>c.baselineRef),...traversalCases.flatMap(c=>[c.benignRef,c.benignMarkerRef,c.traversalRef,c.markerRef]),...ssrfCases.map(c=>c.benignRef),...uploadCases.flatMap(c=>[c.benignNameRef,c.benignContentRef,c.probeNameRef,c.probeContentRef,c.markerRef]),...templateCases.map(c=>c.baselineRef),...xxeCases.flatMap(c=>[c.benignXmlRef,c.templateRef]),...deserCases.flatMap(c=>[c.benignRef,c.templateRef]),...commandCases.flatMap(c=>[c.benignRef,c.templateRef]),...redirectCases.flatMap(c=>[c.safeTargetRef,c.foreignOriginRef]),...businessCancels.flatMap(c=>[c.operationBodyRef,c.cancelBodyRef]),...businessSteps.flatMap(c=>c.steps.map(s=>s.bodyRef).filter((b): b is string => !!b))])];
  const witnessSalt=baseline?.witnesses?.salt??randomUUID();
  const freshInputs={...browserSecrets,...businessSecrets};
  const witnesses={salt:witnessSalt,digests:Object.fromEntries(witnessRefs.map(ref=>[ref,createHash('sha256').update(witnessSalt+'\n'+freshInputs[ref]).digest('hex')]))};
  if(baseline&&JSON.stringify(witnesses.digests)!==JSON.stringify(baseline.witnesses?.digests??{}))throw new AssessmentError('Retest must preserve expected account identities, protected data markers, POST bodies and public application keys; start a new baseline for changed witnesses');
  const run: Assessment = { id: randomUUID(), target, checks: target ? [...new Set(checks)] : [], includeSource,includeDependencies,witnesses,
    status: "running", createdAt: new Date().toISOString(), completed: 0, total: 0, findings: [], events: [],revision:0,profile,scope,authenticated:Boolean(Object.keys(auth).length||browserOptions.login.length||browserOptions.accounts.length),queryAdvisories:input.queryAdvisories===true,protectedPaths,apiSeeds:seeds,openapiPlan,evidence:[],covered:[],baselineId:baseline?.id,browserOptions,businessCases,businessQuotas,businessSteps,businessPricing,businessCancels,businessRaces,businessConsistency,injectionCases,traversalCases,ssrfCases,uploadCases,templateCases,xxeCases,deserCases,commandCases,redirectCases };
  run.total=run.checks.length+Number(includeSource)+Number(includeDependencies)+(profile==="campaign"&&target?1:0)+protectedPaths.length+Number(browserOptions.enabled)+businessCases.length+businessQuotas.length+businessSteps.length+businessPricing.length+businessCancels.length+businessRaces.length+businessConsistency.length+injectionCases.length+traversalCases.length+ssrfCases.length+uploadCases.length+templateCases.length+xxeCases.length+deserCases.length+commandCases.length+redirectCases.length;
  const controller = new AbortController(),deadline=AbortSignal.timeout(scope.timeoutSeconds*1000),signal=AbortSignal.any([controller.signal,deadline]);
  const transport=scopedTransport(scope,signal,auth,run.evidence);
  const event = (message: string) => run.events.push({ at: new Date().toISOString(), message:transport.redact(message) });
  const add=(findings:PentestFinding[],requestIds:string[]=[],browserEvidenceIds:string[]=[])=>{
    for(const raw of findings){const f=enrichFinding({...raw,detail:transport.redact(raw.detail),title:transport.redact(raw.title)},requestIds);if(browserEvidenceIds.length)f.browserEvidenceIds=browserEvidenceIds;const old=baseline?.findings.find(p=>p.fingerprint===f.fingerprint);if(old)f.workflow={...old.workflow};if(!run.findings.some(p=>p.fingerprint===f.fingerprint))run.findings.push(f);}
  };
  event("Assessment started with explicit scope"); save(root, run); active.set(root, { run, controller });
  void (async () => {
    try {
      let pages=scope.seeds;
      if(profile==="campaign"&&target){
        event("Discovering scoped links and OpenAPI GET routes");
        run.discovery={pages:[],skipped:0,truncated:false};
        run.discovery=await discover(scope,transport.request,seeds,signal,(page,response)=>{
          run.discovery!.pages.push(page);
          if(response.ok){add(inspectPage(page.url,response),[run.evidence.at(-1)!.id]);for(const name of ["weak_csp","error_disclosure","mixed_content","credential_form","csrf_review"])run.covered.push(coverageKey(page.url,name));}
          else add([{id:"discovery-error",check:"discovery",verdict:"error",severity:"info",target:page.url,title:"Page could not be assessed",detail:response.error??"Request failed"}],[run.evidence.at(-1)!.id]);
          event("Discovered "+page.url+": HTTP "+response.status);save(root,run);
        });
        pages=run.discovery.pages.map(p=>p.url);run.completed++;
        if(run.discovery.truncated){
          event("Discovery reached page/depth/queue limits; coverage is bounded");
          add([{id:'discovery-coverage',check:'discovery_coverage',verdict:'error',severity:'info',target,title:'Discovery left known in-scope URLs unvisited',detail:`Unvisited by limit: depth=${run.discovery.limits?.depth??0}, pages=${run.discovery.limits?.pages??0}, queue=${run.discovery.limits?.queue??0}. Up to 100 URL samples are recorded in discovery evidence. This is a coverage gap, not a vulnerability.`}]);
        }
        run.total=pages.length*run.checks.length+Number(includeSource)+Number(includeDependencies)+1+protectedPaths.length+Number(browserOptions.enabled)+businessCases.length+businessQuotas.length+businessSteps.length+businessPricing.length+businessCancels.length+businessRaces.length+businessConsistency.length+injectionCases.length+traversalCases.length+ssrfCases.length+uploadCases.length+templateCases.length+xxeCases.length+deserCases.length+commandCases.length+redirectCases.length;
      }
      if(browserOptions.enabled){
        event("Starting isolated browser rendering and verification");
        run.browser={engine:"pending",version:"",pages:[],proofs:[],blocked:[],incomplete:false};
        try{
          await runBrowserAssessment({root,runId:run.id,scope,options:browserOptions,auth,secrets:browserSecrets,signal,evidence:run.evidence,result:run.browser,reserve:transport.reserve,redact:transport.redact,publish:(proof,findings,covered)=>{
            add(findings,proof.requestIds,[proof.id]);run.covered.push(...covered);event(`Browser ${proof.kind}: ${proof.outcome} on ${proof.target}`);save(root,run);
          }});
        }catch(error){signal.throwIfAborted();run.browser.incomplete=true;event("Browser execution did not complete; inspect browser proofs");add([{id:"browser-error",check:"browser_runtime",target,verdict:"error",severity:"info",title:"Browser verification unavailable",detail:"Browser execution did not complete; inspect browser proofs"}]);}
        if(run.browser.discovery?.incomplete)add([{id:'browser-discovery-coverage',check:'browser_discovery_coverage',target,verdict:'error',severity:'info',title:'Rendered link discovery is incomplete',detail:JSON.stringify(run.browser.discovery)}]);
        pages=[...new Set([...pages,...run.browser.pages.map(p=>p.url)])].slice(0,scope.maxPages);run.completed++;
      }
      const tlsOrigins=new Set<string>();
      const plan=pages.flatMap(page=>run.checks.filter(check=>{
        if(check==="exposed_files")return scope.seeds.includes(page);
        if(check!=="tls_info")return true;
        const origin=new URL(page).origin;if(tlsOrigins.has(origin))return false;tlsOrigins.add(origin);return true;
      }).map(check=>({page,check})));
      run.total=plan.length+Number(includeSource)+Number(includeDependencies)+(profile==="campaign"&&target?1:0)+protectedPaths.length+Number(browserOptions.enabled)+businessCases.length+businessQuotas.length+businessSteps.length+businessPricing.length+businessCancels.length+businessRaces.length+businessConsistency.length+injectionCases.length+traversalCases.length+ssrfCases.length+uploadCases.length+templateCases.length+xxeCases.length+deserCases.length+commandCases.length+redirectCases.length;
      for(const {page,check} of plan) {
        signal.throwIfAborted(); event("Checking "+check+" on "+page);
        const offset=run.evidence.length;
        let findings:PentestFinding[];
        try { findings=await runPentestCheck(page, check, signal,transport.request); }
        catch(error){if(!(error instanceof ScopeError))throw error;findings=[{id:"scope-skip",check,verdict:"error",severity:"info",target:page,title:"Check limited by scope exclusions",detail:error.message}];}
        signal.throwIfAborted();add(findings,run.evidence.slice(offset).map(e=>e.id));
        if(!findings.some(f=>f.verdict==="error"))run.covered.push(coverageKey(page,check));
        run.completed++; event("Finished "+check); save(root, run);
      }
      for(const pathname of protectedPaths){
        signal.throwIfAborted();const url=new URL(pathname,target).href,offset=run.evidence.length;
        const authorized=await transport.request(url),anonymous=await transport.request(url,{},true);
        if(authorized.ok&&anonymous.ok&&authorized.body===anonymous.body){
          add([{id:"access-review",check:"access_review",verdict:"finding",severity:"high",target:url,title:"Declared protected route returns identical content anonymously",detail:"Authenticated and anonymous GET responses were both successful and their bounded bodies matched. Review whether the content is private and whether the supplied session is valid; this is not proof of an authorization bypass.",remediation:"Verify the session, enforce authorization on the server, and repeat with a known protected resource."}],run.evidence.slice(offset).map(e=>e.id));
          run.covered.push(coverageKey(url,"access_review"));
        }else if(authorized.ok&&!anonymous.bodyTruncated&&[401,403].includes(anonymous.status)){
          add([{id:"access-denied",check:"access_review",verdict:"pass",severity:"info",target:url,title:"Anonymous access denied on declared protected route",detail:"Authenticated status="+authorized.status+"; anonymous status="+anonymous.status}],run.evidence.slice(offset).map(e=>e.id));run.covered.push(coverageKey(url,"access_review"));
        }else add([{id:"access-inconclusive",check:"access_review",verdict:"error",severity:"info",target:url,title:"Authorization comparison inconclusive",detail:"Authenticated status="+authorized.status+"; anonymous status="+anonymous.status+". A redirect, different public content or an invalid session cannot establish protection."}],run.evidence.slice(offset).map(e=>e.id));
        run.completed++;event("Compared declared protected route "+url);save(root,run);
      }
      if(businessCases.length||businessQuotas.length||businessSteps.length||businessPricing.length||businessCancels.length||businessRaces.length||businessConsistency.length){
        event("Verifying business logic replay, idempotency, quota, step-order, pricing, cancel/refund, race and layer-consistency cases");
        run.business={proofs:[],incomplete:false};
        let crashed=false;
        const engine:BusinessEngineInput={scope,secrets:businessSecrets,auth,signal,evidence:run.evidence,reserve:transport.reserve,redact:transport.redact,request:(u)=>transport.request(u),result:run.business,publish:(proof,findings,covered)=>{
          add(findings,proof.requestIds);run.covered.push(...covered);run.completed++;event("Business case "+proof.caseId+": "+proof.outcome+" on "+proof.target);save(root,run);
        }};
        try{
          if(businessCases.length)await runBusinessCases(engine,businessCases);
        }catch(error){signal.throwIfAborted();crashed=true;run.business.incomplete=true;event("Replay verification did not complete; inspect business proofs");add([{id:"business-error",check:"business_coverage",target,verdict:"error",severity:"info",title:"Business logic verification unavailable",detail:"Replay case execution did not complete; inspect business proofs"}]);}
        try{
          if(businessQuotas.length)await runQuotaCases(engine,businessQuotas);
        }catch(error){signal.throwIfAborted();crashed=true;run.business.incomplete=true;event("Quota verification did not complete; inspect business proofs");add([{id:"business-error",check:"business_coverage",target,verdict:"error",severity:"info",title:"Business logic verification unavailable",detail:"Quota case execution did not complete; inspect business proofs"}]);}
        try{
          if(businessSteps.length)await runStepCases(engine,businessSteps);
        }catch(error){signal.throwIfAborted();crashed=true;run.business.incomplete=true;event("Step-order verification did not complete; inspect business proofs");add([{id:"business-error",check:"business_coverage",target,verdict:"error",severity:"info",title:"Business logic verification unavailable",detail:"Step-order case execution did not complete; inspect business proofs"}]);}
        try{
          if(businessPricing.length)await runPricingCases(engine,businessPricing);
        }catch(error){signal.throwIfAborted();crashed=true;run.business.incomplete=true;event("Pricing verification did not complete; inspect business proofs");add([{id:"business-error",check:"business_coverage",target,verdict:"error",severity:"info",title:"Business logic verification unavailable",detail:"Pricing case execution did not complete; inspect business proofs"}]);}
        try{
          if(businessCancels.length)await runCancelCases(engine,businessCancels);
        }catch(error){signal.throwIfAborted();crashed=true;run.business.incomplete=true;event("Cancel/refund verification did not complete; inspect business proofs");add([{id:"business-error",check:"business_coverage",target,verdict:"error",severity:"info",title:"Business logic verification unavailable",detail:"Cancel/refund case execution did not complete; inspect business proofs"}]);}
        try{
          if(businessRaces.length)await runRaceCases(engine,businessRaces);
        }catch(error){signal.throwIfAborted();crashed=true;run.business.incomplete=true;event("Race verification did not complete; inspect business proofs");add([{id:"business-error",check:"business_coverage",target,verdict:"error",severity:"info",title:"Business logic verification unavailable",detail:"Race case execution did not complete; inspect business proofs"}]);}
        try{
          if(businessConsistency.length)await runConsistencyCases(engine,businessConsistency);
        }catch(error){signal.throwIfAborted();crashed=true;run.business.incomplete=true;event("Layer-consistency verification did not complete; inspect business proofs");add([{id:"business-error",check:"business_coverage",target,verdict:"error",severity:"info",title:"Business logic verification unavailable",detail:"Layer-consistency case execution did not complete; inspect business proofs"}]);}
        if(!crashed&&run.business.incomplete)add([{id:"business-incomplete",check:"business_coverage",target,verdict:"error",severity:"info",title:"Some business logic cases are inconclusive",detail:"At least one case lacked a working state witness, a valid positive control or a completed submission sequence. Inconclusive cases do not establish idempotency, quota enforcement, prerequisite protection, pricing correctness, rollback fidelity, concurrency safety or layer consistency; review the business proofs."}]);
      }
      if(injectionCases.length){
        event("Verifying SQL/NoSQL injection with boolean differentials and stability controls");
        run.injection={proofs:[],incomplete:false};
        let crashed=false;
        try{
          await runInjectionCases({scope,secrets:businessSecrets,auth,signal,evidence:run.evidence,reserve:transport.reserve,redact:transport.redact,result:run.injection,publish:(proof,findings,covered)=>{
            add(findings,proof.requestIds);run.covered.push(...covered);run.completed++;event("Injection case "+proof.caseId+": "+proof.outcome+" on "+proof.target);save(root,run);
          }},injectionCases);
        }catch(error){signal.throwIfAborted();crashed=true;run.injection.incomplete=true;event("Injection verification did not complete; inspect injection proofs");add([{id:"injection-error",check:"injection_coverage",target,verdict:"error",severity:"info",title:"Injection verification unavailable",detail:"Injection case execution did not complete; inspect injection proofs"}]);}
        if(!crashed&&run.injection.incomplete)add([{id:"injection-incomplete",check:"injection_coverage",target,verdict:"error",severity:"info",title:"Some injection cases are inconclusive",detail:"At least one case lacked a successful stable baseline, completed probes or a repeatable response. Inconclusive cases do not establish injection safety; review the injection proofs."}]);
      }
      if(traversalCases.length){
        event("Verifying path traversal with positive and negative file controls");
        run.traversal={proofs:[],incomplete:false};
        let crashed=false;
        try{
          await runTraversalCases({scope,secrets:businessSecrets,auth,signal,evidence:run.evidence,reserve:transport.reserve,redact:transport.redact,result:run.traversal,publish:(proof,findings,covered)=>{
            add(findings,proof.requestIds);run.covered.push(...covered);run.completed++;event("Traversal case "+proof.caseId+": "+proof.outcome+" on "+proof.target);save(root,run);
          }},traversalCases);
        }catch(error){signal.throwIfAborted();crashed=true;run.traversal.incomplete=true;event("Traversal verification did not complete; inspect traversal proofs");add([{id:"traversal-error",check:"traversal_coverage",target,verdict:"error",severity:"info",title:"Traversal verification unavailable",detail:"Traversal case execution did not complete; inspect traversal proofs"}]);}
        if(!crashed&&run.traversal.incomplete)add([{id:"traversal-incomplete",check:"traversal_coverage",target,verdict:"error",severity:"info",title:"Some traversal cases are inconclusive",detail:"At least one case lacked a served benign control, a clean negative control or completed probes. Inconclusive cases do not establish traversal safety; review the traversal proofs."}]);
      }
      if(ssrfCases.length){
        event("Verifying SSRF with a local callback listener and negative baselines");
        run.ssrf={proofs:[],incomplete:false};
        let crashed=false;
        try{
          await runSsrfCases({scope,secrets:businessSecrets,auth,signal,evidence:run.evidence,reserve:transport.reserve,redact:transport.redact,result:run.ssrf,publish:(proof,findings,covered)=>{
            add(findings,proof.requestIds);run.covered.push(...covered);run.completed++;event("SSRF case "+proof.caseId+": "+proof.outcome+" on "+proof.target);save(root,run);
          }},ssrfCases);
        }catch(error){signal.throwIfAborted();crashed=true;run.ssrf.incomplete=true;event("SSRF verification did not complete; inspect SSRF proofs");add([{id:"ssrf-error",check:"ssrf_coverage",target,verdict:"error",severity:"info",title:"SSRF verification unavailable",detail:"SSRF case execution did not complete; inspect SSRF proofs"}]);}
        if(!crashed&&run.ssrf.incomplete)add([{id:"ssrf-incomplete",check:"ssrf_coverage",target,verdict:"error",severity:"info",title:"Some SSRF cases are inconclusive",detail:"At least one case lacked a completed baseline, a clean pre-probe listener or completed probes. Inconclusive cases do not establish SSRF safety; review the SSRF proofs."}]);
      }
      if(uploadCases.length){
        event("Verifying file upload handling with benign controls and retrieval witnesses");
        run.upload={proofs:[],incomplete:false};
        let crashed=false;
        try{
          await runUploadCases({scope,secrets:businessSecrets,auth,signal,evidence:run.evidence,reserve:transport.reserve,redact:transport.redact,result:run.upload,publish:(proof,findings,covered)=>{
            add(findings,proof.requestIds);run.covered.push(...covered);run.completed++;event("Upload case "+proof.caseId+": "+proof.outcome+" on "+proof.target);save(root,run);
          }},uploadCases);
        }catch(error){signal.throwIfAborted();crashed=true;run.upload.incomplete=true;event("Upload verification did not complete; inspect upload proofs");add([{id:"upload-error",check:"upload_coverage",target,verdict:"error",severity:"info",title:"Upload verification unavailable",detail:"Upload case execution did not complete; inspect upload proofs"}]);}
        if(!crashed&&run.upload.incomplete)add([{id:"upload-incomplete",check:"upload_coverage",target,verdict:"error",severity:"info",title:"Some upload cases are inconclusive",detail:"At least one case lacked an accepted benign control or completed probes. Inconclusive cases do not establish upload safety; review the upload proofs."}]);
      }
      if(templateCases.length){
        event("Verifying template injection with dual-expression canaries and stability controls");
        run.template={proofs:[],incomplete:false};
        let crashed=false;
        try{
          await runTemplateCases({scope,secrets:businessSecrets,auth,signal,evidence:run.evidence,reserve:transport.reserve,redact:transport.redact,result:run.template,publish:(proof,findings,covered)=>{
            add(findings,proof.requestIds);run.covered.push(...covered);run.completed++;event("Template case "+proof.caseId+": "+proof.outcome+" on "+proof.target);save(root,run);
          }},templateCases);
        }catch(error){signal.throwIfAborted();crashed=true;run.template.incomplete=true;event("Template verification did not complete; inspect template proofs");add([{id:"template-error",check:"template_coverage",target,verdict:"error",severity:"info",title:"Template verification unavailable",detail:"Template case execution did not complete; inspect template proofs"}]);}
        if(!crashed&&run.template.incomplete)add([{id:"template-incomplete",check:"template_coverage",target,verdict:"error",severity:"info",title:"Some template cases are inconclusive",detail:"At least one case lacked a stable clean baseline or completed probes. Inconclusive cases do not establish template safety; review the template proofs."}]);
      }
      if(xxeCases.length){
        event("Verifying XXE with a local entity server and negative baselines");
        run.xxe={proofs:[],incomplete:false};
        let crashed=false;
        try{
          await runXxeCases({scope,secrets:businessSecrets,auth,signal,evidence:run.evidence,reserve:transport.reserve,redact:transport.redact,result:run.xxe,publish:(proof,findings,covered)=>{
            add(findings,proof.requestIds);run.covered.push(...covered);run.completed++;event("XXE case "+proof.caseId+": "+proof.outcome+" on "+proof.target);save(root,run);
          }},xxeCases);
        }catch(error){signal.throwIfAborted();crashed=true;run.xxe.incomplete=true;event("XXE verification did not complete; inspect XXE proofs");add([{id:"xxe-error",check:"xxe_coverage",target,verdict:"error",severity:"info",title:"XXE verification unavailable",detail:"XXE case execution did not complete; inspect XXE proofs"}]);}
        if(!crashed&&run.xxe.incomplete)add([{id:"xxe-incomplete",check:"xxe_coverage",target,verdict:"error",severity:"info",title:"Some XXE cases are inconclusive",detail:"At least one case lacked an accepted entity-free baseline or completed probes. Inconclusive cases do not establish XXE safety; review the XXE proofs."}]);
      }
      if(deserCases.length){
        event("Verifying unsafe deserialization with a loopback execution witness");
        run.deser={proofs:[],incomplete:false};
        let crashed=false;
        try{
          await runDeserCases({scope,secrets:businessSecrets,auth,signal,evidence:run.evidence,reserve:transport.reserve,redact:transport.redact,result:run.deser,publish:(proof,findings,covered)=>{
            add(findings,proof.requestIds);run.covered.push(...covered);run.completed++;event("Deserialization case "+proof.caseId+": "+proof.outcome+" on "+proof.target);save(root,run);
          }},deserCases);
        }catch(error){signal.throwIfAborted();crashed=true;run.deser.incomplete=true;event("Deserialization verification did not complete; inspect deserialization proofs");add([{id:"deser-error",check:"deser_coverage",target,verdict:"error",severity:"info",title:"Deserialization verification unavailable",detail:"Deserialization case execution did not complete; inspect deserialization proofs"}]);}
        if(!crashed&&run.deser.incomplete)add([{id:"deser-incomplete",check:"deser_coverage",target,verdict:"error",severity:"info",title:"Some deserialization cases are inconclusive",detail:"At least one case lacked an accepted benign baseline or completed probes. Inconclusive cases do not establish deserialization safety; review the deserialization proofs."}]);
      }
      if(commandCases.length){
        event("Verifying command injection with a loopback execution witness");
        run.command={proofs:[],incomplete:false};
        let crashed=false;
        try{
          await runCommandCases({scope,secrets:businessSecrets,auth,signal,evidence:run.evidence,reserve:transport.reserve,redact:transport.redact,result:run.command,publish:(proof,findings,covered)=>{
            add(findings,proof.requestIds);run.covered.push(...covered);run.completed++;event("Command case "+proof.caseId+": "+proof.outcome+" on "+proof.target);save(root,run);
          }},commandCases);
        }catch(error){signal.throwIfAborted();crashed=true;run.command.incomplete=true;event("Command injection verification did not complete; inspect command proofs");add([{id:"command-error",check:"command_coverage",target,verdict:"error",severity:"info",title:"Command injection verification unavailable",detail:"Command injection case execution did not complete; inspect command proofs"}]);}
        if(!crashed&&run.command.incomplete)add([{id:"command-incomplete",check:"command_coverage",target,verdict:"error",severity:"info",title:"Some command injection cases are inconclusive",detail:"At least one case lacked an accepted benign baseline or completed probes. Inconclusive cases do not establish command injection safety; review the command proofs."}]);
      }
      if(redirectCases.length){
        event("Verifying open redirects with in-origin controls and Location witnesses");
        run.redirect={proofs:[],incomplete:false};
        let crashed=false;
        try{
          await runRedirectCases({scope,secrets:businessSecrets,auth,signal,evidence:run.evidence,reserve:transport.reserve,redact:transport.redact,result:run.redirect,publish:(proof,findings,covered)=>{
            add(findings,proof.requestIds);run.covered.push(...covered);run.completed++;event("Redirect case "+proof.caseId+": "+proof.outcome+" on "+proof.target);save(root,run);
          }},redirectCases);
        }catch(error){signal.throwIfAborted();crashed=true;run.redirect.incomplete=true;event("Redirect verification did not complete; inspect redirect proofs");add([{id:"redirect-error",check:"redirect_coverage",target,verdict:"error",severity:"info",title:"Redirect verification unavailable",detail:"Redirect case execution did not complete; inspect redirect proofs"}]);}
        if(!crashed&&run.redirect.incomplete)add([{id:"redirect-incomplete",check:"redirect_coverage",target,verdict:"error",severity:"info",title:"Some redirect cases are inconclusive",detail:"At least one case lacked a working in-origin control or completed probes. Inconclusive cases do not establish redirect safety; review the redirect proofs."}]);
      }
      signal.throwIfAborted();
      if (includeSource) {
        run.scan=scanWorkspaceRoutesAndRisks(root);
        event("Tracing request-shaped data flows across files, imports and middleware");
        run.flowScan=traceSourceFlows(root);
        // Static→dynamic linking: join each flow's source-file route with any
        // dynamic finding proven live on that same path.
        run.flowScan.links=linkFlowsToDynamicEvidence(run.flowScan.flows,run.scan.routes,run.findings.filter(f=>f.verdict==="finding"&&/^(?:injection_|xss_|traversal_|ssrf_|template_|xxe_|deser_|command_|redirect_)/.test(f.check)).map(f=>({check:f.check,target:f.target})));
        for(const flow of run.flowScan.flows){
          const target=flow.sink.file+":"+flow.sink.line;
          const kind=flow.sink.kind==="sql_like"?"SQL-like":flow.sink.kind==="html_like"?"HTML-injecting":"command-like";
          const links=run.flowScan.links.filter(l=>l.sink===target);
          const dynamicNote=links.length?` Dynamic evidence on the same route: ${links.map(l=>l.check+" observed on "+l.url+" (route "+l.route+")").join("; ")}. The static hop chain and the live proof describe the same surface from both directions.`:"";
          add([{id:"source_flow",check:"source_flow",verdict:"finding",severity:flow.sink.kind==="command_like"?"high":"medium",target,title:`Cross-file data flow reaches a ${kind} sink: ${target}`,detail:`Source ${flow.source.file}:${flow.source.line} (${flow.source.what}) travels through ${flow.hops.length} hop(s) (${flow.hops.map(h=>`${h.file}:${h.line}`).join(" → ")}) into ${flow.sink.what} at ${target}.${dynamicNote} Static syntactic approximation over imports and function parameters — a review candidate, not taint proof; absence of flows proves nothing.${run.flowScan.sanitized?` ${run.flowScan.sanitized} sanitizer/validator call(s) were modeled and cut from the flow graph.`:""}${run.flowScan.guardCuts?` ${run.flowScan.guardCuts} early-return guard cut(s) were modeled.`:""}`,remediation:flow.sink.kind==="sql_like"?"Bind values as parameters at the query; validate identifiers with an allowlist.":flow.sink.kind==="html_like"?"Encode by output context at the sink; never build HTML from request-shaped data.":"Pass a validated argv array to the process API instead of a built string."}]);
        }
        if(run.flowScan.coverage.bounded)add([{id:"source-flow-bounded",check:"source_flow_coverage",target:root,verdict:"error",severity:"info",title:"Cross-file flow analysis was bounded",detail:JSON.stringify(run.flowScan.coverage)}]);
        add(run.scan.staticRisks.map(r=>({id:"source",check:r.check??("source_"+(/secret/.test(r.rule)?"secret":/Dynamic/.test(r.rule)?"execution":"html")),verdict:"finding",severity:r.severity,target:r.file+":"+r.line,title:r.rule,detail:r.snippet,remediation:r.check==='source_sql'?"Use the database driver's parameter binding for values. Validate dynamic identifiers with an explicit allowlist; value placeholders cannot bind table or column names. Review data provenance and test the original request after repair. This static indicator does not prove SQL injection.":r.check==='source_nosql'?"Validate request values against a strict schema before building filters. Use explicit fields and scalar types; do not accept client-controlled query/operator objects. Review driver sanitization and test allowed and denied record access after repair. This static indicator does not prove NoSQL injection.":"Review data flow and callers at this source location; a static pattern alone does not confirm exploitability."})));
        run.completed++;event("Inspected "+run.scan.filesScanned+" source files (limit: 200)");
        if(run.scan.coverage?.incomplete)add([{id:'source-incomplete',check:'source_coverage',verdict:'error',severity:'info',target:root,title:'Source analysis coverage is incomplete',detail:JSON.stringify(run.scan.coverage)}]);
        if(!run.scan.filesScanned)add([{id:'source-empty',check:'source_coverage',verdict:'error',severity:'info',target:root,title:'No source files assessed',detail:'The selected task workspace contains no eligible source files. Add the application source to this task before source assessment.'}]);
      }
      if(includeDependencies){
        run.inventory=inspectDependencies(root);
        if(run.queryAdvisories){event("Querying OSV with dependency names and exact versions only");await queryAdvisories(run.inventory,signal);}
        add(run.inventory.findings);run.completed++;event("Inventoried "+run.inventory.packages.length+" locked dependencies");
        if(!run.inventory.packages.length)add([{id:'dependencies-empty',check:'dependency_coverage',verdict:'error',severity:'info',target:root,title:'No locked dependencies assessed',detail:'No supported locked packages were found in the task workspace; dependency coverage is incomplete.'}]);
      }
      run.status=run.findings.some(f=>f.verdict==="error")||run.inventory?.advisories?.complete===false||run.discovery?.truncated||run.browser?.incomplete||run.business?.incomplete||run.injection?.incomplete||run.traversal?.incomplete||run.ssrf?.incomplete||run.upload?.incomplete||run.template?.incomplete||run.xxe?.incomplete||run.deser?.incomplete||run.command?.incomplete||run.redirect?.incomplete?"partial":"completed";
    } catch (error) {
      run.status=controller.signal.aborted?"cancelled":run.evidence.length||deadline.aborted?"partial":"failed";
      run.error=transport.redact(deadline.aborted?"Campaign time budget reached":error instanceof Error?error.message:String(error));
    } finally {
      if(baseline)run.comparison=compareFindings(baseline.id,baseline.findings,run.findings,run.covered);
      // Self-planning (advisory only): derive the suggested next-step
      // checklist from this run's own evidence, after execution finished.
      if(run.status!=="running")run.plan=buildPlan(run);
      run.finishedAt=new Date().toISOString();event("Assessment "+run.status);
      try { save(root,run); } catch(error){run.status="failed";run.error="Could not persist assessment: "+String(error);}
      for(const key of Object.keys(auth))delete auth[key];
      for(const key of Object.keys(browserSecrets))delete browserSecrets[key];
      for(const key of Object.keys(businessSecrets))delete businessSecrets[key];
      active.delete(root);
    }
  })();
  return run;
}

