import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const profile=process.env.LOAM_USER_DATA_DIR||path.join(process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming'),'manus-local');
const destination=path.join(profile,'updates');await fs.mkdir(destination,{recursive:true});
const file=`Loam-Setup-${version}.exe`,source=path.join(root,'release',file);
const data=await fs.readFile(source),sha512=crypto.createHash('sha512').update(data).digest('base64');
const packagedVersion=JSON.parse(await fs.readFile(path.join(root,'release/win-unpacked/resources/app/package.json'),'utf8')).version;
if(packagedVersion!==version)throw new Error('Packaged version does not match package.json. Build the installer before publishing.');
let previous='';try{previous=await fs.readFile(path.join(destination,'latest.yml'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
const previousVersion=previous.match(/^version:\s*(\S+)/m)?.[1];
const previousHash=previous.match(/^sha512:\s*(\S+)/m)?.[1];
if(previousVersion===version&&previousHash!==sha512)throw new Error('This version is already published with different contents. Increase the package version and rebuild.');
if(previousVersion&&/^\d+\.\d+\.\d+$/.test(previousVersion)&&/^\d+\.\d+\.\d+$/.test(version)){
 const oldParts=previousVersion.split('.').map(Number),newParts=version.split('.').map(Number);
 const difference=newParts.map((part,index)=>part-oldParts[index]).find(part=>part!==0);
 if(difference<0)throw new Error('Cannot replace a newer published release with an older version.');
}
await fs.copyFile(source,path.join(destination,file));
await fs.copyFile(source+'.blockmap',path.join(destination,file+'.blockmap'));
const manifest=`version: ${version}\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: ${data.length}\npath: ${file}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`;
await fs.writeFile(path.join(destination,'latest.yml.tmp'),manifest);
await fs.rename(path.join(destination,'latest.yml.tmp'),path.join(destination,'latest.yml'));
console.log(`Published Loam ${version} to the local update channel: ${destination}`);
