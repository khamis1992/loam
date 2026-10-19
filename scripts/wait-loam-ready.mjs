import fs from 'node:fs/promises';
const version=JSON.parse(await fs.readFile('package.json','utf8')).version,deadline=Date.now()+55000;
while(Date.now()<deadline){try{const response=await fetch('http://127.0.0.1:3939/api/identity',{signal:AbortSignal.timeout(1500)});const identity=await response.json();if(identity.version===version){console.log('READY Loam '+version);process.exit(0);}}catch{}await new Promise(resolve=>setTimeout(resolve,1000));}
throw Error('Installed Loam '+version+' is not ready yet; inspect the running process before retrying.');
