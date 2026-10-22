import fs from 'node:fs';
import path from 'node:path';
import {androidFiles} from '../mobile/android/generate.js';
import {recordsFixture} from './mobile-records-fixture.js';
const root=path.resolve('release/mobile-live/record-sync/android');
const native=androidFiles(recordsFixture,'loam-record-sync-proof');
for(const [name,content]of Object.entries(native.files)){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}
const sdk=path.join(process.env.LOCALAPPDATA!,'Android','Sdk');if(!fs.existsSync(sdk))throw Error('Android SDK not found');
fs.writeFileSync(path.join(root,'local.properties'),'sdk.dir='+sdk.replaceAll('\\','/')+'\n');
console.log(JSON.stringify({root,applicationId:native.applicationId,sourceHash:native.sourceHash}));
