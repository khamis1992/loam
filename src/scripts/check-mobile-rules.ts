import assert from 'node:assert/strict';
import {validateCollections,parseRecordState,mutateRecords,validateRecord,type MobileCollection} from '../../ui/mobile-data.js';
const collection:MobileCollection={id:'reservations',title:'الحجوزات',singular:'حجز',titleField:'name',fields:[
 {id:'name',label:'الاسم',type:'text',required:true},{id:'price',label:'السعر',type:'number',min:0,max:100,integer:true},
 {id:'start',label:'البداية',type:'date'},{id:'end',label:'النهاية',type:'date'},
 {id:'slot',label:'الفترة',type:'select',options:['صباح','مساء']},{id:'active',label:'نشط',type:'boolean'},
],rules:[{id:'dates',type:'compare',field:'end',otherField:'start',operator:'gte',message:'النهاية تسبق البداية'},
 {id:'slot_once',type:'unique',fields:['start','slot'],when:{field:'active',equals:true},message:'الفترة محجوزة'},
]};
const schemas=validateCollections([collection]);assert.deepEqual(schemas,[collection]);
for(const change of [
 (c:any)=>c.fields[1].min=101,(c:any)=>c.fields[1].integer='true',(c:any)=>c.fields[0].min=0,
 (c:any)=>c.rules[0].otherField='name',(c:any)=>c.rules[0].field='missing',
 (c:any)=>c.rules[1].fields=['slot','slot'],(c:any)=>c.rules[1].when.equals='true',
 (c:any)=>c.rules[1].when.field='name',(c:any)=>c.rules[1].type='javascript',
]){const broken=structuredClone(collection);change(broken);assert.throws(()=>validateCollections([broken]));}
let state=parseRecordState(null);const good={name:'سارة',price:0,start:'2026-11-01',end:'2026-11-01',slot:'صباح',active:true};
for(const price of [-1,101,1.5,'0x1p2','Infinity'])assert.ok(validateRecord(collection,{...good,price},state).errors.price);
assert.ok(validateRecord(collection,{...good,end:'2026-10-31'},state).errors.end);
const strict=structuredClone(collection);(strict.rules![0] as any).operator='gt';assert.ok(validateRecord(strict,good,state).errors.end);
state=mutateRecords(state,schemas,{type:'save',collectionId:collection.id,values:good}).state;const first=state.collections.reservations![0]!;
assert.equal(validateRecord(collection,good,state).errors.start,'الفترة محجوزة');assert.deepEqual(validateRecord(collection,good,state,first.id).errors,{});
assert.deepEqual(validateRecord(collection,{...good,active:false},state).errors,{});
assert.deepEqual(validateRecord(collection,{...good,start:'2026-11-02',end:'2026-11-02'},state).errors,{});
assert.deepEqual(validateRecord(collection,{...good,slot:''},state).errors,{});
state=mutateRecords(state,schemas,{type:'delete',collectionId:collection.id,id:first.id}).state;
state=mutateRecords(state,schemas,{type:'save',collectionId:collection.id,values:{...good,name:'بديل'}}).state;
const before=JSON.stringify(state);assert.throws(()=>mutateRecords(state,schemas,{type:'restore',collectionId:collection.id,id:first.id}),/الفترة محجوزة/);assert.equal(JSON.stringify(state),before);
console.log('PASS business rules: schema safety, bounds/integer, ordered dates, composite/conditional uniqueness, self-edit, cancelled/empty slots, deletion and conflicting restore');
