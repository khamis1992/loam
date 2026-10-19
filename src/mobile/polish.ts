import { extractJson } from '../agent/planner.js';
import type { ChatMessage, OllamaClient } from '../ollama.js';
import { mobileDesignSchema } from './schema.js';
import { MobileError, validateProject, type MobileProject } from './store.js';
import {chooseDesignProfile, mobileDesignContext} from '../../ui/mobile-design.js';

export const MOBILE_DESIGN_RULES = `Design useful, calm, professional mobile experiences, not stacks of generic controls. Every screen needs design:{eyebrow,description,guidance,icon}. Eyebrow: 2-4 words describing the purpose, NEVER repeat the screen title. Description: one concise welcoming or explanatory sentence specific to this screen. Guidance: one practical, specific suggestion with an example, not generic motivation and not a duplicate of description. Icon: book,briefcase,spark,check,sun,flag,note,target. The renderer turns navigation into destination cards and computes progress from actual toggles. Never invent stats, completed tasks, streaks, dates, cloud features or capabilities. Fields need descriptive labels, short help and realistic example placeholders (examples, never prefilled data). Toggles must describe exactly what completion means on that screen, NEVER just Complete or مكتملة. Save buttons MUST name what is saved, NEVER just Save or حفظ. Keep navigation labels short and identify the destination. Use natural Arabic, no technical jargon or claims of services that do not exist. Avoid formulaic قم ب and الخاصة بك. Use consistent neutral Arabic imperatives; do not switch gender. Never mention controls, toggles, inputs or code in user-facing copy.`;

export function checkPolishedCopy(screen:{title:string;design:{eyebrow:string;description:string;guidance:string};blocks:Array<{type:string;text:string;help?:string;placeholder?:string;target?:string}>},arabic:boolean){
  const problems:string[]=[];
  for(const b of screen.blocks){
    if(b.type==='button'&&!b.target&&/^(حفظ|احفظ|save)$/i.test(b.text.trim()))problems.push('Save button must name its object: e.g. حفظ خطة التعلم, not حفظ.');
    if(b.type==='button'&&b.target&&/^(حفظ|احفظ|save)(\s|$)/i.test(b.text.trim()))problems.push('Navigation button must name its destination, never say Save.');
    if(b.type==='toggle'&&/^(مكتمل[ةه]?|تم|إنجاز|انجاز|done|complete[d]?)$/i.test(b.text.trim()))problems.push('Toggle must describe a specific completed action: e.g. راجعت أهداف التعلم, not مكتملة.');
  }
  if(arabic&&/(?:toggle|[ء-ي]oggle|placeholder|undefined|\b(?:input|button|screen)\b)/i.test([screen.design.eyebrow,screen.design.description,screen.design.guidance,...screen.blocks.flatMap(b=>[b.text,b.help||'',b.placeholder||''])].join(' ')))problems.push('Remove leaked code/control names from the Arabic user-facing copy.');
  if(problems.length)throw Error([...new Set(problems)].join(' '));
}

export const MOBILE_CONTEXT_RULE = 'Treat examples in the request as examples of writing quality, not required app content. Never copy a task, subject, time or completion statement into an unrelated screen. A completion label must describe this screen\'s actual purpose. Generic task pages must not assume a specific task such as checking email, studying or exercising. Before answering, compare every label against this screen title and reject unrelated example content.';

/** Presentation-only edits: original IDs, types, links and screen topology never enter the mutation surface. */
export async function polishMobile(o: { current: MobileProject; model: string; brief: string; ollama: Pick<OllamaClient,'chat'>; signal: AbortSignal; emit: (event:Record<string,unknown>)=>void }) {
  const candidate=structuredClone(o.current);let attempts=0;
  if(!candidate.designSystem){const profile=chooseDesignProfile(candidate.title+' '+o.brief);candidate.designSystem={version:1,profile};}
  for(const [index,screen] of candidate.screens.entries()) {
    const fields=screen.blocks.map(b=>({type:'object',additionalProperties:false,required:['id','text',...(b.type==='input'?['help','placeholder']:[])],properties:{id:{type:'string',const:b.id},text:{type:'string',minLength:1,maxLength:120},help:{type:'string',minLength:1,maxLength:180},...(b.type==='input'?{placeholder:{type:'string',minLength:1,maxLength:120}}:{})}}));
    const schema={type:'object',additionalProperties:false,required:['design','blocks'],properties:{design:mobileDesignSchema,blocks:{type:'array',minItems:fields.length,maxItems:fields.length,items:fields.length?{anyOf:fields}:{type:'object'}}}};
    const messages:ChatMessage[]=[{role:'system' as const,content:`You are an expert Arabic product writer refining ONE screen in Loam Mobile Studio. Rewrite weak existing copy; it is a draft, not a wording constraint. ${MOBILE_DESIGN_RULES} Return only JSON {design:{eyebrow,description,guidance,icon},blocks:[{id,text,help?,placeholder?}]}. Include every supplied block ID exactly once. Do not change IDs, types, targets, title or hierarchy. Content language must match the supplied screen. Example of quality for a reading page: eyebrow="مساحة للفهم", description="اختر فكرة واحدة من قراءتك اليوم وحوّلها إلى خطوة عملية.", guidance="بعد قراءة فصل، لخّص فكرته في جملة ودوّن سؤالًا تريد استكشافه.", input.text="الفكرة التي أريد تذكرها", input.help="اكتبها بأسلوبك لتسهيل الرجوع إليها.", input.placeholder="مثال: تقسيم المهمة إلى خطوات صغيرة يساعدني على البدء", toggle.text="دوّنت الفكرة وخطوتها التالية", save.text="حفظ فكرة القراءة". Adapt this level of specificity to THIS screen; do not copy the reading example verbatim. ${screen.kind==='primary'?'This is a primary landing page: description should orient the user and guidance should propose a concrete starting action.':'This is a focused detail page: describe the task and offer a useful, domain-specific example.'}`},{role:'user' as const,content:JSON.stringify({request:o.brief,app:o.current.title,screen:{...screen,design:undefined},destinations:screen.blocks.filter(b=>b.target).map(b=>({id:b.target,title:candidate.screens.find(s=>s.id===b.target)?.title}))})}];
    messages[0]!.content += '\n'+MOBILE_CONTEXT_RULE+'\n'+mobileDesignContext(candidate.designSystem.profile);
    for(let attempt=1;attempt<=3;attempt++) {
      o.signal.throwIfAborted();attempts++;
      o.emit({type:'phase',phase:'polish',screen:screen.title,index:index+1,total:candidate.screens.length,attempt});
      const result=await o.ollama.chat({model:o.model,messages,temperature:0,signal:o.signal,timeoutMs:180_000,...(!o.model.includes('cloud')?{format:schema}:{})});
      o.signal.throwIfAborted();
      try {
        const patch=extractJson(result.content) as {design:unknown;blocks:Array<{id:string;text:string;help?:string;placeholder?:string}>};
        if(!patch?.design||!Array.isArray(patch.blocks)||patch.blocks.length!==screen.blocks.length||new Set(patch.blocks.map(b=>b.id)).size!==screen.blocks.length||patch.blocks.some(b=>!screen.blocks.some(old=>old.id===b.id)))throw Error('Include every original block ID exactly once.');
        const changed={...screen,design:patch.design,blocks:screen.blocks.map(b=>{const entry=patch.blocks.find(x=>x.id===b.id)!;if(b.type==='input'&&(!entry.help||!entry.placeholder))throw Error('Each input needs help and an example placeholder.');return {...b,text:entry.text,...(entry.help?{help:entry.help}:{}),...(b.type==='input'&&entry.placeholder?{placeholder:entry.placeholder}:{})};})};
        const checked=validateProject({...candidate,screens:candidate.screens.map(s=>s.id===screen.id?changed:s)});
        const refined=checked.screens.find(s=>s.id===screen.id)!;
        checkPolishedCopy({...refined,design:refined.design!},o.current.direction==='rtl');
        candidate.screens=checked.screens;
        o.emit({type:'polished',screen:screen.title,index:index+1,total:candidate.screens.length});break;
      }catch(error){const reason=error instanceof Error?error.message:String(error);o.emit({type:'repair',attempt,reason});if(attempt===3)throw new MobileError('تعذّر تحسين صفحة '+screen.title+'؛ بقي المشروع المحفوظ كما هو.');messages.push({role:'assistant',content:result.content.slice(0,18000)},{role:'user',content:'Fix the previous response: '+reason+'. Return the complete screen design and all block labels.'});}
    }
  }
  return {project:candidate,attempts};
}
