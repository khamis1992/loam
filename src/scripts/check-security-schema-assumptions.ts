import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {analyzeNoSqlSource} from '../security/source-nosql.js';

// Trusted local fixtures only. This verifies schema behavior, not database access.
const require=createRequire(path.join(path.resolve(process.argv[2]??'output/verification/schema-runtime'),'package.json'));
const Ajv=require('ajv');
const version=require('ajv/package.json').version;
const Joi=require('joi');const joiVersion=require('joi/package.json').version;
const ajv=new Ajv();
const fields={date:{type:'string'},title:{type:'string'}};
const open={type:'object',properties:fields};
const closed={...open,additionalProperties:false};
const cases=[
  {id:'ordinary-data',data:{date:'2026-10-18',title:'fixture'},open:true,closed:true},
  {id:'unknown-operator-key',data:{$or:[{title:'fixture'}]},open:true,closed:false},
  {id:'unknown-expression-key',data:{$expr:{$eq:[1,1]}},open:true,closed:false},
  {id:'unknown-ordinary-key',data:{other:'fixture'},open:true,closed:false},
  {id:'operator-object-in-string-field',data:{title:{$ne:null}},open:false,closed:false},
  {id:'empty-object',data:{},open:true,closed:true},
];
const openCheck=ajv.compile(open),closedCheck=ajv.compile(closed);
const rows=cases.map(test=>{
  const data=JSON.parse(JSON.stringify(test.data));
  const a=openCheck(data),b=closedCheck(data);
  assert.equal(a,test.open,test.id+' open');assert.equal(b,test.closed,test.id+' closed');
  assert.deepEqual(data,test.data,'Default validation should not remove fields');
  return {id:test.id,openAccepted:a,closedAccepted:b};
});
// Closing only the root still permits operator-shaped objects in an open nested schema.
const nested=ajv.compile({type:'object',properties:{title:{type:'object'}},additionalProperties:false});
assert.equal(nested({title:{$ne:null}}),true);
// A validated STRING is not a validated decoded object.
const stringCheck=ajv.compile({type:'string'});
const serialized=JSON.stringify({title:{$ne:null}});
assert.equal(stringCheck(serialized),true);assert.equal(closedCheck(JSON.parse(serialized)),false);
// Arbitrary validator calls, open schemas and post-validation decoding must not
// silently suppress source indicators just to match an external expected file.
const source='import Ajv from "ajv"; import {MongoClient} from "mongodb"; const ajv=new Ajv(); const schema={type:"object",properties:{title:{type:"string"}}}; const check=ajv.compile(schema); function handler(req){const query=JSON.parse(req.query.data); if(check(query)){db.find(query);} if(ajv.validate(schema,query)){db.find(query);}}';
assert.equal(analyzeNoSqlSource('schema.js',source).risks.length,2);
const joiSchema=Joi.object({date:Joi.string().required(),title:Joi.string().required()}).with('date','title');
const ordinary={date:'2026-10-18',title:'fixture'};
assert.equal(joiSchema.validate(ordinary).error,undefined);
const extra={...ordinary,$or:[{title:'fixture'}]};
assert.equal(joiSchema.validate(extra).error.details[0].type,'object.unknown');
assert.equal(joiSchema.validate({...ordinary,title:{$ne:null}}).error.details[0].type,'string.base');
assert.equal(joiSchema.unknown(true).validate(extra).error,undefined,'Joi validation is not blanket sanitization either');
assert.deepEqual(joiSchema.validate(extra).value,extra,'Rejected original input is not made safe for reuse');
const report={createdAt:new Date().toISOString(),ajvVersion:version,joiVersion,schemas:{open,closed},cases:rows,nestedOpenAcceptedOperatorObject:true,stringValidationDoesNotValidateDecodedObject:true,
  joi:{defaultRejectsUnknownOperatorKey:true,defaultRejectsObjectInStringField:true,unknownTrueAllowsOperatorKey:true,errorResultRetainsOriginalInput:true},
  interpretation:'Schema validation is not blanket query sanitization. Default additional properties can preserve operator-shaped keys. Closed flat scalar schemas block these specific fixtures, but empty filters still pass. No database operation, exploit confirmation or claim about every validator/version.'};
const output=path.resolve('output/verification/security-schema-assumptions.json');
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(`PASS: Ajv ${version}, Joi ${joiVersion}; ${cases.length} open/closed controls, nested-object/decoded-string and Joi unknown-field counterexamples; source warnings retained. ${output}`);
