import assert from 'node:assert/strict';
import JSZip from 'jszip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importStudio,loadImport } from '../studio/import.js';
import { exportStudio } from '../studio/export.js';
import { saveStudio } from '../studio/store.js';
import { safeZip, xml } from '../studio/ooxml.js';
let checks=0;
const reject=async(buffer:Buffer)=>{await assert.rejects(()=>safeZip(buffer));checks++;};
const z=new JSZip();z.file('word/document.xml','<document>safe</document>',{createFolders:false});const good=await z.generateAsync({type:'nodebuffer',compression:'DEFLATE'});await safeZip(good);checks++;
await reject(Buffer.from('not an Office archive'));
const end=good.length-22,central=good.readUInt32LE(end+16);
const badCRC=Buffer.from(good);badCRC.writeUInt32LE(0,central+16);await reject(badCRC);
const encrypted=Buffer.from(good);encrypted.writeUInt16LE(1,central+8);await reject(encrypted);
const localOffset=Buffer.from(good);localOffset.writeUInt32LE(central,central+42);await reject(localOffset);
const sizeBomb=Buffer.from(good);sizeBomb.writeUInt32LE(30_000_001,central+24);await reject(sizeBomb);
const z2=new JSZip();z2.file('word/document.xml','x'.repeat(2_000_000),{createFolders:false});const forged=await z2.generateAsync({type:'nodebuffer',compression:'DEFLATE'});const c2=forged.readUInt32LE(forged.length-6);forged.writeUInt32LE(1,c2+24);await reject(forged);
for(const name of ['../outside.xml','word/vbaProject.bin','word/activeX/control.xml']){const zip=new JSZip();zip.file(name,'x');await reject(await zip.generateAsync({type:'nodebuffer'}));}
assert.equal(xml('<root><text>safe &amp; sound</text></root>').documentElement.textContent,'safe & sound');checks++;
for(const raw of ['<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///C:/private">]><foo>&x;</foo>','<!ENTITY x "hello"><foo/>','<unclosed>']){assert.throws(()=>xml(raw));checks++;}
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'loam-import-safety-'));try{
 const one=path.join(temporary,'one'),two=path.join(temporary,'two');fs.mkdirSync(one);fs.mkdirSync(two);
 const native=await exportStudio({kind:'document',title:'Safety',revision:1,content:{blocks:[{type:'paragraph',text:'Private task one'}]}});
 const imported=await importStudio(one,native.buffer,'safe.docx',0);
 assert.throws(()=>saveStudio(two,imported,0),/unavailable in this task/);checks++;
 assert.throws(()=>loadImport(two,imported.sourceId!),/unavailable in this task/);checks++;
 assert.throws(()=>loadImport(one,'../outside'),/Invalid import source/);checks++;
 fs.mkdirSync(path.join(two,'.loam'));fs.symlinkSync(path.join(one,'.loam','imports'),path.join(two,'.loam','imports'),'junction');
 assert.throws(()=>loadImport(two,imported.sourceId!));checks++;
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
console.log(`PASS Office import safety (${checks} checks): bounded spoofed-size decompression, CRC, encryption, ZIP offsets/traversal, macros, XML entities and malformed XML`);

