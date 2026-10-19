import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {taskPath} from '../server/taskWorkspace.js';
import type {MobileProject} from './store.js';

export type CodeState={files:Record<string,string>};
export type MobileVersion={id:string;revision:number;label:string;createdAt:string|null;bookmarked:boolean;snapshot:string};
export function atomicJson(root:string,name:string,value:unknown){
 const file=taskPath(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});
 const temp=taskPath(root,name+'.'+randomUUID()+'.tmp');
 try{fs.writeFileSync(temp,JSON.stringify(value),{flag:'wx'});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
export function readCode(root:string):CodeState{
 const file=taskPath(root,'.loam/mobile-code.json');
 return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{files:{}};
}
export function codeTag(code:CodeState){return createHash('sha256').update(JSON.stringify(code)).digest('hex');}
export function listVersions(root:string):MobileVersion[]{
 const file=taskPath(root,'.loam/mobile-versions.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
}
export function recordVersion(root:string,project:MobileProject,label='حفظ تغييرات التطبيق',createdAt:string|null=new Date().toISOString()){
 const snapshot={project,code:readCode(root)},hash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
 const versions=listVersions(root);if(versions.at(-1)?.snapshot===hash)return;
 const name='.loam/mobile-history/'+hash+'.json';if(!fs.existsSync(taskPath(root,name)))atomicJson(root,name,snapshot);
 versions.push({id:randomUUID(),revision:project.revision,label:label.slice(0,160),createdAt,bookmarked:false,snapshot:hash});
 atomicJson(root,'.loam/mobile-versions.json',versions);
}
export function seedVersions(root:string,project:MobileProject){
 if(listVersions(root).length)return;
 const saved=JSON.parse(fs.readFileSync(taskPath(root,'.loam/mobile.json'),'utf8'));
 for(const old of saved.history?.past||[])recordVersion(root,old,'إصدار سابق · '+old.title,null);
 recordVersion(root,project,'النسخة الحالية · '+project.title,null);
}
export function versionSnapshot(root:string,id:unknown){
 const version=listVersions(root).find(v=>v.id===id);if(!version)throw new Error('الإصدار غير موجود');
 if(!/^[a-f0-9]{64}$/.test(version.snapshot))throw new Error('Invalid snapshot');
 return JSON.parse(fs.readFileSync(taskPath(root,'.loam/mobile-history/'+version.snapshot+'.json'),'utf8')) as {project:MobileProject;code:CodeState};
}
export function bookmarkVersion(root:string,id:unknown,value:unknown){
 const versions=listVersions(root),version=versions.find(v=>v.id===id);if(!version||typeof value!=='boolean')throw new Error('إصدار أو إشارة مرجعية غير صالحة');
 version.bookmarked=value;atomicJson(root,'.loam/mobile-versions.json',versions);return versions;
}
