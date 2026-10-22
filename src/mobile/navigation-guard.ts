import {MobileError,type MobileProject} from './store.js';

/** Content edits may add screens, but existing page identities and navigation stay stable.
 * Explicit restructuring is a separate opt-in; never infer it from model output. */
export function protectNavigation(current:MobileProject,candidate:Record<string,unknown>):number{
 if(!current.screens.some(s=>s.blocks.length)||!Array.isArray(candidate.screens))return 0;
 const screens=candidate.screens as Record<string,unknown>[];let corrected=0;
 for(const before of current.screens){
  const after=screens.find(s=>s&&s.id===before.id);
  if(!after)throw new MobileError(`Preserve existing screen ${before.id}. Navigation is locked for this content edit. Return every existing screen and its IDs.`);
  const kind=before.kind||'primary';
  if(after.kind!==kind||after.parentId!==before.parentId){corrected++;after.kind=kind;if(before.parentId)after.parentId=before.parentId;else delete after.parentId;}
  for(const link of before.blocks.filter(b=>b.type==='button'&&b.target)){
   const next=Array.isArray(after.blocks)&&after.blocks.find(b=>b&&typeof b==='object'&&(b as Record<string,unknown>).id===link.id) as Record<string,unknown>|undefined;
   if(!next||next.type!=='button'||next.target!==link.target)throw new MobileError(`Preserve navigation button ${link.id} on ${before.id}, type button, target ${link.target}. Navigation is locked; change only the requested content.`);
  }
 }
 return corrected;
}
