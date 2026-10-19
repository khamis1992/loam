import { mobileIcons } from './store.js';
import { DESIGN_PROFILES } from '../../ui/mobile-design.js';
const label = { type: 'string', minLength: 1, maxLength: 2000 };
const id = { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$', maxLength: 80 };
const ruleMessage={...label,maxLength:240};
const collectionRules={type:'array',maxItems:16,items:{oneOf:[
 {type:'object',additionalProperties:false,required:['id','type','field','otherField','operator','message'],properties:{id,type:{const:'compare',type:'string'},field:id,otherField:id,operator:{type:'string',enum:['gt','gte']},message:ruleMessage}},
 {type:'object',additionalProperties:false,required:['id','type','fields','message'],properties:{id,type:{const:'unique',type:'string'},fields:{type:'array',minItems:1,maxItems:8,uniqueItems:true,items:id},when:{type:'object',additionalProperties:false,required:['field','equals'],properties:{field:id,equals:{anyOf:[{type:'string'},{type:'boolean'}]}}},message:ruleMessage}},
]}};
const fieldBase={id,label:{...label,maxLength:120},required:{type:'boolean'}};
const dataField={oneOf:[
 ...['text','date','boolean'].map(type=>({type:'object',additionalProperties:false,required:['id','label','type'],properties:{...fieldBase,type:{type:'string',const:type}}})),
 {type:'object',additionalProperties:false,required:['id','label','type'],properties:{...fieldBase,type:{type:'string',const:'number'},min:{type:'number',minimum:-1e12,maximum:1e12},max:{type:'number',minimum:-1e12,maximum:1e12},integer:{type:'boolean'}}},
 {type:'object',additionalProperties:false,required:['id','label','type','options'],properties:{...fieldBase,type:{type:'string',const:'select'},options:{type:'array',minItems:1,maxItems:12,uniqueItems:true,items:{...label,maxLength:120}}}},
 {type:'object',additionalProperties:false,required:['id','label','type','collectionId'],properties:{...fieldBase,type:{type:'string',const:'relation'},collectionId:id}},
]};
export const collectionsSchema={type:'array',maxItems:16,items:{type:'object',additionalProperties:false,required:['id','title','singular','titleField','fields'],properties:{id,title:{...label,maxLength:120},singular:{...label,maxLength:120},titleField:id,subtitleField:id,rules:collectionRules,fields:{type:'array',minItems:1,maxItems:16,items:dataField}}}};
const collectionBlock={type:'object',additionalProperties:false,required:['id','type','text','collectionId'],properties:{id,type:{type:'string',const:'collection'},text:label,collectionId:id}};
export const mobileDesignSchema = { type:'object',additionalProperties:false,required:['eyebrow','description','guidance','icon'],properties:{eyebrow:{...label,maxLength:60},description:{...label,maxLength:220},guidance:{...label,maxLength:240},icon:{type:'string',enum:[...mobileIcons]}} };
const help = {...label,maxLength:180}, placeholder = {...label,maxLength:120};
export const mobileSchema: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['version', 'title', 'accent', 'direction', 'screens'],
  properties: {
    collections:collectionsSchema,
    designSystem: {type:'object',additionalProperties:false,required:['version','profile'],properties:{version:{type:'integer',const:1},profile:{type:'string',enum:Object.keys(DESIGN_PROFILES)}}},
    version: { type: 'integer', const: 1 }, title: { ...label, maxLength: 160 },
    accent: { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' }, direction: { type: 'string', enum: ['rtl', 'ltr'] },
    screens: { type: 'array', minItems: 1, maxItems: 100, items: {
      type: 'object', additionalProperties: false, required: ['id', 'title', 'group', 'kind', 'blocks'], properties: {
        id, title: { ...label, maxLength: 120 }, group: { ...label, maxLength: 80 }, design: mobileDesignSchema, kind: { type: 'string', enum: ['primary', 'detail'] }, parentId: id, blocks: { type: 'array', maxItems: 60, items: { oneOf: [collectionBlock,
          { type: 'object', additionalProperties: false, required: ['id', 'type', 'text'], properties: { id, type: { type: 'string', enum: ['heading', 'text', 'toggle'] }, text: label, help } },
          { type: 'object', additionalProperties: false, required: ['id', 'type', 'text'], properties: { id, type: { type: 'string', const: 'input' }, text: label, help, placeholder } },
          { type: 'object', additionalProperties: false, required: ['id', 'type', 'text'], properties: { id, type: { type: 'string', const: 'button' }, text: label, target: id, help } }
        ] } }
      }
    } }
  }
};
export const blockPatchSchema: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['text'], properties: { text: label, type:{type:'string',enum:['heading','text','input','toggle','button']}, target: { anyOf: [id, { type: 'null' }] } }
};

// Separate collections constrain the model to at most five sections and make
// parentId mandatory for every detail page, without relying on prompt compliance.
const generationBlock = { oneOf: [collectionBlock,
  { type: 'object', additionalProperties: false, required: ['id', 'type', 'text'], properties: { id, type: { type: 'string', enum: ['heading', 'text', 'toggle'] }, text: label, help } },
  { type: 'object', additionalProperties: false, required: ['id', 'type', 'text', 'help', 'placeholder'], properties: { id, type: { type: 'string', const: 'input' }, text: label, help, placeholder } },
          { type: 'object', additionalProperties: false, required: ['id', 'type', 'text'], properties: { id, type: { type: 'string', const: 'button' }, text: label, target: id, help } }
] };
const generationScreen = { id, title: { ...label, maxLength: 120 }, group: { ...label, maxLength: 80 }, design: mobileDesignSchema, blocks: { type: 'array', minItems: 1, maxItems: 60, items: generationBlock } };
export const mobileGenerationSchema: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['version', 'title', 'accent', 'direction', 'sections', 'pages'],
  properties: {
    collections:collectionsSchema,
    version: { type: 'integer', const: 1 }, title: { ...label, maxLength: 160 }, accent: { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' }, direction: { type: 'string', enum: ['rtl', 'ltr'] },
    sections: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['id','title','group','design','blocks'], properties: generationScreen } },
    pages: { type: 'array', maxItems: 99, items: { type: 'object', additionalProperties: false, required: ['id','title','group','parentId','design','blocks'], properties: { ...generationScreen, parentId: id } } }
  }
};
