import {spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Release gate for the security platform: runs every `check:security*` gate
// from package.json sequentially and fails if ANY gate regresses. Gates are
// enumerated from the manifest, so a newly added gate joins the release chain
// automatically — no gate can silently drop out of the quality bar. All gates
// run even after a failure so the summary names every regression, not just
// the first.

// npm runs scripts from the package root, so the manifest resolves from cwd
// (import.meta.dirname is unavailable under tsx).
const manifestPath=path.resolve(process.cwd(),"package.json");
const manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8")) as {scripts?: Record<string,string>};
const gates=Object.keys(manifest.scripts??{}).filter(name=>name.startsWith("check:security")).sort();
if(!gates.length)throw Error("No check:security* gates found in package.json");
console.log(`Release gate: running ${gates.length} security gates sequentially`);

const failed: Array<{gate: string; code: number}>=[];
let index=0;
for(const gate of gates){
  index++;
  const started=Date.now();
  process.stdout.write(`[${String(index).padStart(2,"0")}/${gates.length}] ${gate} ... `);
  const result=spawnSync("npm",["run","--silent",gate],{stdio:["ignore","pipe","pipe"],shell:process.platform==="win32",env:process.env});
  const seconds=((Date.now()-started)/1000).toFixed(1);
  if(result.status===0){console.log(`PASS (${seconds}s)`);}
  else{
    console.log(`FAIL (exit ${result.status}, ${seconds}s)`);
    const tail=(Buffer.concat([result.stdout??Buffer.alloc(0),result.stderr??Buffer.alloc(0)]).toString("utf8").trim().split(/\r?\n/).slice(-15).join("\n"));
    if(tail)console.log(tail.split("\n").map(line=>"    "+line).join("\n"));
    failed.push({gate,code:result.status??-1});
  }
}

console.log("");
if(failed.length){
  console.log(`RELEASE GATE FAILED: ${failed.length}/${gates.length} gate(s) regressed:`);
  for(const {gate,code} of failed)console.log(`  - ${gate} (exit ${code})`);
  process.exit(1);
}
console.log(`RELEASE GATE PASSED: all ${gates.length} security gates green`);
