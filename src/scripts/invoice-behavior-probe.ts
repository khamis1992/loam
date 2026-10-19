import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {BackendSandbox} from '../agent/backendSandbox.js';

/** Execute generated JavaScript only inside the same bounded, offline sandbox
 * used for generated applications, never by importing it into the test host. */
export async function probeInvoice(workspace:string){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-invoice-probe-'));
 fs.copyFileSync(path.join(workspace,'invoice.mjs'),path.join(root,'invoice.mjs'));
 fs.writeFileSync(path.join(root,'probe.mjs'),`import http from 'node:http';
import {total} from './invoice.mjs';
const rejected=(items)=>{try{total(items);return null;}catch(error){return error instanceof RangeError?'RangeError':String(error);}};
http.createServer((req,res)=>{if(req.url!=='/probe'){res.writeHead(200).end('ready');return;}
try{res.setHeader('content-type','application/json');res.end(JSON.stringify({empty:total([]),sum:total([{quantity:2,price:12.5},{quantity:3,price:0.1}]),negativeQuantity:rejected([{quantity:-1,price:4}]),negativePrice:rejected([{quantity:1,price:-4}])}));}catch(error){res.writeHead(500).end(String(error));}}).listen(3000,'0.0.0.0');`);
 const signal=AbortSignal.timeout(60000);
 const sandbox=await BackendSandbox.start(root,'probe.mjs',signal);
 try{
  const response=await sandbox.request('/probe','GET',{},'',signal);
  assert.equal(response.status,200);
  const observations=JSON.parse(Buffer.from(response.body,'base64').toString('utf8'));
  assert.deepEqual(observations,{empty:0,sum:25.3,negativeQuantity:'RangeError',negativePrice:'RangeError'});
  return {assertions:4,observations,isolation:'docker-network-none',imageId:sandbox.imageId};
 }finally{await sandbox.close();}
}
