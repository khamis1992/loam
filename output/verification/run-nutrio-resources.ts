import fs from 'node:fs';
import path from 'node:path';
import {startAssessment,readAssessment} from '../../src/security/assessments.js';
const old=JSON.parse(fs.readFileSync('output/verification/nutrio-assessments.json','utf8').replace(/^\uFEFF/,''))[0];
const root=path.resolve('output/verification/nutrio-resource-check');fs.mkdirSync(root,{recursive:true});
const run=startAssessment(root,{target:old.target,authorized:true,profile:'quick',checks:['server_banner'],scope:{delayMs:0,maxRequests:1000,timeoutSeconds:180},browser:{...old.browserOptions,totalLimitBytes:100000000,responseLimitBytes:10000000,readinessTimeoutMs:30000,networkIdleTimeoutMs:10000,screenshots:false}});
for(let i=0;i<1900;i++){const r=readAssessment(root,run.id);if(r.status!=='running'){fs.writeFileSync('output/verification/nutrio-resource-result.json',JSON.stringify(r,null,2));console.log(JSON.stringify({id:r.id,status:r.status,requests:r.evidence.length,resources:r.browser?.resources,proofs:r.browser?.proofs.map(p=>({kind:p.kind,outcome:p.outcome,summary:p.summary,observations:p.observations})),blocked:r.browser?.blocked,errors:r.evidence.filter(e=>e.error).map(e=>({url:e.url,error:e.error}))},null,2));break;}await new Promise(resolve=>setTimeout(resolve,100));}
