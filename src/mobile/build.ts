import type { ChatMessage, OllamaClient } from '../ollama.js';
import { extractJson } from '../agent/planner.js';
import { MobileError, readMobile, saveMobile, validateProject, checkCollectionCompatibility, type Block } from './store.js';
import { mobileGenerationSchema, blockPatchSchema } from './schema.js';
import { MOBILE_DESIGN_RULES, MOBILE_CONTEXT_RULE, polishMobile, checkPolishedCopy } from './polish.js';
import {chooseDesignProfile, DESIGN_PROFILES, mobileDesignContext} from '../../ui/mobile-design.js';
import {reviewMobileData} from './data-review.js';
import {protectNavigation} from './navigation-guard.js';
import {readMobileKnowledge} from './local-services.js';

type Emit = (event: Record<string, unknown>) => void;
const running = new Set<string>();
export const MOBILE_DATA_RULES = "Business validation belongs in the schema, not guidance text. Number fields support min, max and integer:true (counts/copies/pages must be integers, prices non-negative). Collections support rules (max 16), each with unique id and a specific user-facing message. Compare dates or numbers: {id:\"valid_due\",type:\"compare\",field:\"due\",otherField:\"start\",operator:\"gte\",message:\"موعد الإرجاع يجب أن يلي تاريخ الإعارة\"}; use gt for strictly later/greater. A compare rule must reference TWO DIFFERENT fields of the same number/date type. Never compare a field to itself or to a numeric literal. Constant bounds belong only in field min/max, never in compare rules. Uniqueness across active non-deleted records: {id:\"unique_isbn\",type:\"unique\",fields:[\"isbn\"],message:\"هذا الرمز مسجل بالفعل\"}. Composite uniqueness can have a condition: {id:\"one_active_loan\",type:\"unique\",fields:[\"book\"],when:{field:\"returned\",equals:false},message:\"هذا الكتاب مُعار حاليًا\"}. Conditions reference boolean or select fields only. Uniqueness checks all listed fields together; empty optional values do not conflict. Edits exclude the same record; restored records must pass rules again. For appointments at fixed slots, use a select slot plus date and a unique rule over resource/date/slot, optionally active-only. Do not claim arbitrary interval overlap detection, live capacity, automated inventory, payment or computed analytics: these are not available. Preserve existing rules unless asked to change them.";
export const MOBILE_BUILD_SYSTEM = `You design working mobile apps in Loam Mobile Studio. Return ONLY a JSON object, no markdown or tools.
Output schema: {"version":1,"title":"App name","accent":"#267965","direction":"rtl","sections":[{"id":"screen_home","title":"Home","group":"General","blocks":[{"id":"open_details","type":"button","text":"Open details","target":"screen_details"}]}],"pages":[{"id":"screen_details","title":"Details","group":"General","parentId":"screen_home","blocks":[{"id":"block_note","type":"input","text":"Note"}]}]}.
Use TWO separate arrays: sections contains ONLY the 1-5 main bottom-navigation sections; pages contains ALL other detail pages. Do not put detail pages in sections. Never emit kind: collection membership determines it. Total sections plus pages must be at most 100. Every page MUST have parentId, which can reference a section or another page. Sections MUST NOT have parentId. No parent cycles. Every parent must contain an actual button with target pointing to EACH of its child pages. The runtime provides Back automatically; do not add redundant Back buttons. Preserve existing IDs, groups and parent relations when editing. The current project uses screens with kind primary/detail; convert those to sections/pages in your output.
Allowed block types: heading,text,input,toggle,button,collection. All screen/block IDs globally unique, ASCII letters/digits/underscores, start with a letter. Text must be nonempty. A button with target:<existing screen id> navigates; a button WITHOUT target saves locally. Inputs and toggles persist locally. Use collection blocks for real lists of records with create/edit/delete/search and local persistence: block {id,type:"collection",text:"List title",collectionId:"tasks"}. Define top-level collections:[{id:"tasks",title:"المهام",singular:"مهمة",titleField:"name",fields:[{id:"name",label:"عنوان المهمة",type:"text",required:true},{id:"done",label:"مكتملة",type:"boolean"}]}]. Each collection needs id,title,singular,titleField,fields. titleField MUST be a required text field. Field types: text,number,date,boolean,select (requires unique options array),relation (requires collectionId referencing another collection). Max 16 collections and 16 fields each. Lists provide search, forms, validation, edit/delete and restore automatically. Do NOT create separate add/edit/detail pages or redundant input/save blocks for collections unless the user explicitly asks for those extra pages. When the user only requests collection sections, use pages:[]; the collection provides its own form. A record-specific details page cannot be implemented using static input blocks. Use collections whenever the user needs multiple tasks/books/bookings/items, not a single fixed form or toggles standing in for records. Do not generate fake sample records. Keep existing collection and field IDs to preserve user data. Saved web previews and local releases use task-scoped SQLite services for validated records and input values. The runtime provides a local account panel (register/login/logout) and file storage; owner-only access is configured in studio services. Do not invent auth screens, payment processing, cloud sync or arbitrary server functions. Secrets remain server-only; never put credentials in generated content.
${MOBILE_DATA_RULES}
${MOBILE_DESIGN_RULES}
${MOBILE_CONTEXT_RULE}
Design polished useful content: short screen titles, screen design metadata, labeled fields, meaningful primary actions. The renderer already shows the title and description; do not duplicate them in heading/text blocks. Add heading/text blocks only for distinct useful content. Every input needs help and placeholder. Any information the user enters (book name, author, page count, notes, ideas) MUST be an input block, not static text. Use toggle for completion. Honor the requested screen count and hierarchy exactly; count sections AND pages before answering. Check that every requested field exists. Use Arabic text and rtl when the request is Arabic. Preserve existing IDs and content except requested edits. Return the ENTIRE project. Never return a plan or explanation.`;

export async function buildMobile(o: { root: string; model: string; brief: string; expectedRevision: unknown; allowNavigationChanges?:boolean; operation?: 'polish'|'review-data'; selection?: { screenId: string; blockId: string }; ollama: Pick<OllamaClient, 'chat'>; signal: AbortSignal; emit: Emit }) {
  if (running.has(o.root)) throw new MobileError('يوجد بناء جارٍ لهذا المشروع. انتظر أو أوقفه أولًا.', 409);
  const current = readMobile(o.root);
  if (!current || current.revision !== o.expectedRevision) throw new MobileError('تغيّر المشروع. أعد تحميله قبل البناء.', 409);
  const profile=current.designSystem?.profile||chooseDesignProfile(current.title+' '+o.brief);
  const original = o.selection && current.screens.find(s => s.id === o.selection!.screenId)?.blocks.find(b => b.id === o.selection!.blockId);
  if (o.selection && !original) throw new MobileError('العنصر المحدد لم يعد موجودًا. اختره مجددًا.');
  running.add(o.root);
  try {
    if(o.operation==='review-data'){
      if(o.selection||!current.collections?.length)throw new MobileError('مراجعة القواعد تحتاج مجموعات بيانات وتعمل على المشروع كله.');
      o.emit({type:'phase',phase:'data_review',attempt:1});
      const reviewed=await reviewMobileData({collections:current.collections,brief:o.brief,model:o.model,ollama:o.ollama,signal:o.signal,rules:MOBILE_DATA_RULES,onRepair:(attempt,reason)=>o.emit({type:'data_review_repair',attempt,reason})});
      const candidate=validateProject({...current,collections:reviewed.collections});checkCollectionCompatibility(current,candidate);
      o.signal.throwIfAborted();const project=saveMobile(o.root,candidate,current.revision,o.brief),blocks=project.screens.flatMap(s=>s.blocks);
      o.emit({type:'data_reviewed',collections:project.collections?.length,usage:reviewed.usage,audit:reviewed.audit});
      o.emit({type:'done',operation:'review-data',project,checks:{screens:project.screens.length,collections:project.collections?.length||0,fields:blocks.filter(b=>b.type==='input'||b.type==='toggle').length+(project.collections||[]).reduce((n,c)=>n+c.fields.length,0),navigation:blocks.filter(b=>b.target).length,saves:blocks.filter(b=>b.type==='button'&&!b.target).length},attempt:reviewed.attempts,model:o.model});return;
    }
    if(o.operation==='polish'){
      if(o.selection)throw new MobileError('تحسين التصميم يعمل على المشروع كله؛ ألغِ تحديد العنصر.');
      const result=await polishMobile({current,model:o.model,brief:o.brief,ollama:o.ollama,signal:o.signal,emit:o.emit});
      o.signal.throwIfAborted();const project=saveMobile(o.root,result.project,current.revision,o.brief),blocks=project.screens.flatMap(s=>s.blocks);
      o.emit({type:'done',operation:'polish',project,checks:{screens:project.screens.length,collections:project.collections?.length||0,fields:blocks.filter(b=>b.type==='input'||b.type==='toggle').length+(project.collections||[]).reduce((n,c)=>n+c.fields.length,0),navigation:blocks.filter(b=>b.target).length,saves:blocks.filter(b=>b.type==='button'&&!b.target).length},attempt:result.attempts,model:o.model});return;
    }
    const system = original ? `You edit ONE mobile app block. Return ONLY JSON {"text":"new label","type":"optional requested block type","target":"optional existing screen ID"}. No tools or explanation. Keep the requested language. Allowed screen IDs: ${current.screens.map(s => s.id).join(', ')}. Omit type unless the user explicitly requests conversion. Allowed conversions: heading,text,input,toggle,button; collection blocks cannot be converted. Use toggle for a persistent completion switch. Omit target to preserve existing behavior. Use target:null only when asked to change a button to local save. Only buttons may have target. You cannot change other elements.` : MOBILE_BUILD_SYSTEM;
    const navigationRule=!o.allowNavigationChanges&&!original&&current.screens.some(s=>s.blocks.length)?'\nNavigation is locked for this content edit: preserve ALL existing screen IDs, primary/detail kinds, parent IDs and existing navigation button IDs and targets. You may add new screens with valid links. Only change the requested content.':'';
    const knowledge=readMobileKnowledge(o.root);
    const messages: ChatMessage[] = [{ role: 'system', content: system+'\n'+mobileDesignContext(profile)+navigationRule }, { role: 'user', content: JSON.stringify({ request: o.brief, ...(knowledge?{projectKnowledge:knowledge}:{}), current: original ?? current }) }];
    for (let attempt = 1; attempt <= 3; attempt++) {
      o.signal.throwIfAborted();
      o.emit({ type: 'phase', phase: attempt === 1 ? 'generate' : 'repair', attempt, model: o.model });
      const result = await o.ollama.chat({ model: o.model, messages, temperature: 0, signal: o.signal, timeoutMs: 180_000, ...(!o.model.includes('cloud') ? { format: original ? blockPatchSchema : mobileGenerationSchema } : {}) });
      o.signal.throwIfAborted();
      o.emit({ type: 'phase', phase: 'validate', attempt });
      let candidate;
      try {
        const parsed = extractJson(result.content);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Return a JSON object, not an empty answer.');
        if (original) {
          const patch = parsed as Record<string, unknown>;
          candidate = structuredClone(current);
          const block = candidate.screens.find(s => s.id === o.selection!.screenId)!.blocks.find(b => b.id === original.id)!;
          block.text = patch.text as string;
          if(Object.hasOwn(patch,'type')){
            if(original.type==='collection'||!['heading','text','input','toggle','button'].includes(String(patch.type)))throw new MobileError('Unsupported selected block conversion');
            block.type=patch.type as Block['type'];if(block.type!=='button')delete block.target;if(block.type!=='input')delete block.placeholder;
          }
          if (block.type === 'button' && Object.hasOwn(patch, 'target')) { delete block.target; if (patch.target !== null) block.target = patch.target as string; }
        } else {
          const generated = parsed as Record<string, unknown>;
          candidate = Array.isArray(generated.sections) && Array.isArray(generated.pages)
            ? { ...generated, screens: [...generated.sections.map(s => ({ ...s, kind: 'primary' })), ...generated.pages.map(s => ({ ...s, kind: 'detail' }))] }
            : parsed;
        }
        if(!original){
          const generated=candidate as Record<string,unknown>;
          const colorRequested=/لون|ألوان|الوان|\b(?:colou?r|palette|accent)\b/i.test(o.brief);
          const accent=colorRequested?generated.accent:current.screens.some(s=>s.blocks.length)?current.accent:DESIGN_PROFILES[profile]!.tokens.primary;
          candidate={...generated,designSystem:{version:1,profile},accent};
        }
        if(!original&&!o.allowNavigationChanges){const corrected=protectNavigation(current,candidate as Record<string,unknown>);if(corrected)o.emit({type:'navigation_preserved',screens:corrected});}
        const validated = validateProject(candidate);
        checkCollectionCompatibility(current,validated);
        candidate = validated;
        if(JSON.stringify(validated)===JSON.stringify(validateProject(current)))throw new Error('The result is identical to the saved project. Apply the requested change; do not return the unchanged project.');
        if (!candidate.screens.some(s => s.blocks.length)) throw new Error('The project is empty. Add the requested content and actions.');
        if (!original) {
          const copyProblems:string[]=[];
          for(const screen of validated.screens)if(screen.design)try{checkPolishedCopy({...screen,design:screen.design},validated.direction==='rtl');}catch(error){copyProblems.push(screen.id+': '+(error instanceof Error?error.message:String(error)));}
          if(copyProblems.length)throw new Error(copyProblems.join('; '));
          const missing = validated.screens.filter(s => s.kind === 'detail').flatMap(screen => {
            const parent = validated.screens.find(s => s.id === screen.parentId)!;
            return parent.blocks.some(b => b.target === screen.id) ? [] : [`${parent.id} -> ${screen.id}`];
          });
          if (missing.length) throw new Error(`Missing parent-to-child navigation button links: ${missing.join('; ')}. Add ALL listed links as button blocks on their source pages, with target equal to the destination ID. Preserve all requested pages and existing links.`);
        }
        for (const screen of candidate.screens) for (const block of screen.blocks) {
          if (block.type === 'button' && block.target && /^(?:حفظ|احفظ|save)(?:\s|$)/i.test(block.text.trim())) {
            throw new Error(`Button ${JSON.stringify(block.id)} is labelled as save but navigates. Remove its target to save locally. Navigation actions must have navigation labels.`);
          }
        }
        // A focused second pass checks data requirements without the competing screen/copy task.
        // Existing projects still pass compatibility checks before any schema is committed.
        if(!original&&candidate.collections?.length&&!current.collections?.length){
          o.emit({type:'phase',phase:'data_review',attempt});
          const reviewed=await reviewMobileData({collections:candidate.collections,brief:o.brief,model:o.model,ollama:o.ollama,signal:o.signal,rules:MOBILE_DATA_RULES,onRepair:(attempt,reason)=>o.emit({type:'data_review_repair',attempt,reason})});
          candidate=validateProject({...candidate,collections:reviewed.collections});
          checkCollectionCompatibility(current,candidate);
          o.emit({type:'data_reviewed',collections:candidate.collections?.length,usage:reviewed.usage,audit:reviewed.audit});
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        o.emit({ type: 'repair', attempt, reason });
        if (attempt === 3) throw new MobileError('تعذّر تصحيح المسودة بعد ثلاث محاولات. بقيت نسختك المحفوظة كما هي. جرّب طلبًا أقصر.');
        messages.push({ role: 'assistant', content: result.content.slice(0, 50000) }, { role: 'user', content: `Validation failed: ${reason}. Fix this error and return the complete valid JSON only.` });
        continue;
      }
      o.signal.throwIfAborted();
      // Compare-and-swap prevents a late response from overwriting edits from another session.
      const project = saveMobile(o.root, candidate, current.revision,o.brief);
      const blocks: Block[] = project.screens.flatMap(s => s.blocks);
      const checks = { screens: project.screens.length, collections:project.collections?.length||0,fields: blocks.filter(b => b.type === 'input' || b.type === 'toggle').length+(project.collections||[]).reduce((n,c)=>n+c.fields.length,0), navigation: blocks.filter(b => b.target).length, saves: blocks.filter(b => b.type === 'button' && !b.target).length };
      o.emit({ type: 'done', project, checks, attempt, model: result.model });
      return;
    }
  } finally { running.delete(o.root); }
}

