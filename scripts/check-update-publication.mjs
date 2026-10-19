import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'loam-publication-'));
try{
 await fs.mkdir(path.join(root,'scripts'),{recursive:true});
 await fs.mkdir(path.join(root,'release/win-unpacked/resources/app'),{recursive:true});
 await fs.copyFile('scripts/publish-local-update.mjs',path.join(root,'scripts/publish.mjs'));
 const prepare=async version=>{
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({version}));
  await fs.writeFile(path.join(root,'release/win-unpacked/resources/app/package.json'),JSON.stringify({version}));
  await fs.writeFile(path.join(root,`release/Loam-Setup-${version}.exe`),'fixture '+version);
  await fs.writeFile(path.join(root,`release/Loam-Setup-${version}.exe.blockmap`),'fixture');
 };
 const publish=()=>execFileSync(process.execPath,[path.join(root,'scripts/publish.mjs')],{env:{...process.env,LOAM_USER_DATA_DIR:path.join(root,'profile')},stdio:'pipe'});
 const manifest=()=>fs.readFile(path.join(root,'profile/updates/latest.yml'),'utf8');
 await prepare('0.5.25');publish();publish();const original=await manifest();
 await fs.writeFile(path.join(root,'release/Loam-Setup-0.5.25.exe'),'different contents');
 assert.throws(publish,/already published with different contents/);assert.equal(await manifest(),original);
 await prepare('0.5.24');assert.throws(publish,/newer published release/);assert.equal(await manifest(),original);
 await prepare('0.5.26');await fs.writeFile(path.join(root,'release/win-unpacked/resources/app/package.json'),JSON.stringify({version:'0.5.24'}));
 assert.throws(publish,/Packaged version does not match/);assert.equal(await manifest(),original);
 await prepare('0.5.26');publish();assert.match(await manifest(),/^version: 0.5.26/m);
 console.log('PASS publication: new version, idempotence, changed-content rejection, downgrade rejection, package mismatch and preserved manifest on failure');
}finally{await fs.rm(root,{recursive:true,force:true});}
