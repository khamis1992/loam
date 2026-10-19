import JSZip from "jszip";
import { inflateRawSync } from "node:zlib";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { StudioError } from "./store.js";
export const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main', A='http://schemas.openxmlformats.org/drawingml/2006/main', P='http://schemas.openxmlformats.org/presentationml/2006/main', S='http://schemas.openxmlformats.org/spreadsheetml/2006/main', R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export function xml(raw:string): any { if (/<!DOCTYPE|<!ENTITY/i.test(raw) || raw.length>15_000_000) throw new StudioError('Unsupported or oversized XML'); try { let failed=false; const doc=new DOMParser({onError:(level:string)=>{if(level!=='warning')failed=true;}}).parseFromString(raw,'application/xml'); if(failed)throw new StudioError('Invalid Office XML'); return doc; } catch { throw new StudioError('Invalid Office XML'); } }
export const serialize=(node:any):string=>new XMLSerializer().serializeToString(node);
export const all=(node:any,ns:string,name:string):any[]=>Array.from(node.getElementsByTagNameNS(ns,name));
export const first=(node:any,ns:string,name:string):any=>all(node,ns,name)[0];
export const attr=(node:any,name:string,fallback=''):string=>node?.getAttribute(name)||fallback;
export function textOf(node:any,ns:string):string {let output='';const visit=(n:any)=>{if(n.namespaceURI===ns&&n.localName==='t'){output+=n.textContent;return;}if(n.namespaceURI===ns&&(n.localName==='br'||n.localName==='cr')){output+='\n';return;}if(n.namespaceURI===ns&&n.localName==='tab'){output+='\t';return;}for(let child=n.firstChild;child;child=child.nextSibling)visit(child);};visit(node);return output;}
export function patchText(node:any,ns:string,value:string):void {
 const nodes=all(node,ns,'t'); if(!nodes.length)return;
 for(const br of all(node,ns,'br'))br.parentNode?.removeChild(br);
 let offset=0;nodes.forEach((n,i)=>{const size=n.textContent.length;const part=i===nodes.length-1?value.slice(offset):value.slice(offset,offset+size);offset+=size;const lines=part.split('\n');n.textContent=lines[0];n.setAttribute('xml:space','preserve');let previous=n;for(const line of lines.slice(1)){const br=n.ownerDocument.createElementNS(ns,ns===W?'w:br':'a:br'),t=n.ownerDocument.createElementNS(ns,ns===W?'w:t':'a:t');t.textContent=line;t.setAttribute('xml:space','preserve');if(ns===A&&n.parentNode.localName==='r'){const previousRun=previous.localName==='r'?previous:n.parentNode;const run=n.parentNode.cloneNode(false),props=first(n.parentNode,A,'rPr');if(props)run.appendChild(props.cloneNode(true));run.appendChild(t);previousRun.parentNode.insertBefore(br,previousRun.nextSibling);br.parentNode.insertBefore(run,br.nextSibling);previous=run;}else{n.parentNode.insertBefore(br,previous.nextSibling);n.parentNode.insertBefore(t,br.nextSibling);previous=t;}}});
}
export function escapeXml(value:string):string{return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
/** Bound actual decompression before passing any bytes to JSZip. */
export async function safeZip(buffer:Buffer):Promise<JSZip>{
 const reject=(message='Unsafe or oversized Office archive'):never=>{throw new StudioError(message);};
 if(buffer.length>25_000_000 || buffer.length<22)reject('Office file must be below 25 MB');
 let end=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50 && i+22+buffer.readUInt16LE(i+20)===buffer.length){end=i;break;}
 if(end<0)reject('Select an unencrypted DOCX, PPTX or XLSX file');
 const count=buffer.readUInt16LE(end+10),offset=buffer.readUInt32LE(end+16),directorySize=buffer.readUInt32LE(end+12);
 if(buffer.readUInt16LE(end+4)||buffer.readUInt16LE(end+6)||buffer.readUInt16LE(end+8)!==count||count>5000||count===65535||offset===0xffffffff||offset+directorySize!==end)reject();
 const crcTable=Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
 const checksum=(value:Buffer)=>{let crc=0xffffffff;for(const byte of value)crc=crcTable[(crc^byte)&255]!^(crc>>>8);return (crc^0xffffffff)>>>0;};
 let pos=offset,total=0;const names=new Set<string>();for(let n=0;n<count;n++){
  if(pos+46>end||buffer.readUInt32LE(pos)!==0x02014b50)reject('Invalid ZIP directory');
  const flags=buffer.readUInt16LE(pos+8),method=buffer.readUInt16LE(pos+10),crc=buffer.readUInt32LE(pos+16),compressed=buffer.readUInt32LE(pos+20),size=buffer.readUInt32LE(pos+24),len=buffer.readUInt16LE(pos+28),extra=buffer.readUInt16LE(pos+30),comment=buffer.readUInt16LE(pos+32),local=buffer.readUInt32LE(pos+42);
  if(pos+46+len+extra+comment>end||!len)reject();
  const name=buffer.subarray(pos+46,pos+46+len).toString('utf8');
  if(flags&1||![0,8].includes(method)||compressed===0xffffffff||size===0xffffffff||size>30_000_000||size+total>100_000_000||names.has(name)||name.includes('..')||name.startsWith('/')||name.includes('\\')||name.includes('\0'))reject();
  if(/vbaProject|activeX|embeddings\/.*\.(?:bin|exe)$/i.test(name))reject('Macros and embedded executable objects are not supported');
  if(local+30>offset||buffer.readUInt32LE(local)!==0x04034b50||buffer.readUInt16LE(local+6)!==flags||buffer.readUInt16LE(local+8)!==method)reject('Invalid ZIP entry');
  const localNameLength=buffer.readUInt16LE(local+26),dataStart=local+30+localNameLength+buffer.readUInt16LE(local+28);
  if(dataStart+compressed>offset||!buffer.subarray(local+30,local+30+localNameLength).equals(buffer.subarray(pos+46,pos+46+len)))reject('Invalid ZIP entry');
  const payload=buffer.subarray(dataStart,dataStart+compressed);let inflated:Buffer;
  try{inflated=method===0?payload:inflateRawSync(payload,{maxOutputLength:Math.max(1,Math.min(size,30_000_000,100_000_000-total))});}catch{reject('Invalid or oversized compressed Office entry');}
  if(inflated!.length!==size||checksum(inflated!)!==crc)reject('Corrupt Office archive');total+=inflated!.length;
  names.add(name);pos+=46+len+extra+comment;
 }
 if(pos!==end)reject('Invalid ZIP directory');
 const zip=await JSZip.loadAsync(buffer,{checkCRC32:false});if(Object.keys(zip.files).length!==count)reject('Invalid archive entries');return zip;
}
export async function part(zip:JSZip,name:string):Promise<any>{const file=zip.file(name);if(!file)throw new StudioError('Missing Office part: '+name);return xml(await file.async('string'));}
