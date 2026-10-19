import { mobileSchema } from '../mobile/schema.js';
import { MobileError, readMobile, saveMobile, type MobileProject } from '../mobile/store.js';
import type { Tool } from './registry.js';
import {chooseDesignProfile} from '../../ui/mobile-design.js';
function evidence(project: MobileProject | null) {
  if (!project) return { project: null };
  return { revision: project.revision, title: project.title, validation: { uniqueSafeIds: true, validNavigationTargets: true }, screens: project.screens.map(s=>({ title: s.title, fields: s.blocks.filter(b=>b.type==='input'||b.type==='toggle').map(b=>b.text), buttons: s.blocks.filter(b=>b.type==='button').map(b=>({ text: b.text, action: b.target ? 'navigate:'+b.target : 'save-local' })) })), project };
}
export function createMobileTools(): Tool[] {
  return [{ name: 'loam_mobile', description: 'Read or replace the live mobile studio project. Read first and preserve user edits. Project: version:1,title,accent (#RRGGBB),direction (rtl/ltr),screens (1..100). Screen: id,title,group,kind (primary/detail),parentId (required for detail only),blocks (max 60). Use 1..5 primary sections; detail pages have a parent and Back. Add buttons for forward navigation. Preserve navigation metadata. Block: globally unique safe id starting with a letter,type (heading/text/button/input/toggle/collection),text; button may have target screen id. Buttons without targets save form data locally in the generated app. Inputs and toggles persist locally. Real record lists use block type collection with collectionId; define project.collections entries with id,title,singular,titleField,fields. Fields need id,label,type (text/number/date/boolean/select/relation), optional required, select options array, relation collectionId. titleField references a required text field. Collections provide search/create/edit/delete/restore with local storage and checked relationships, max 16 collections and 16 fields each. Never use static fields to pretend to be a list of records. Pass expectedRevision from read, or 0 for new projects. This edits a working screen-based app, not an APK or signed store build. For advanced logic use file tools to extend exported source and run real checks.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['read','replace'] },
      expectedRevision: { type: 'integer', minimum: 0, description: 'Required for replace. Use revision from the latest read; after a conflict read again before retrying.' },
      project: mobileSchema
    }, required: ['action'] },
    async run(args, ctx) {
      if (!ctx.taskId) return { ok: false, content: 'An active task is required' };
      try {
        if (args.action === 'read') return { ok: true, content: JSON.stringify(evidence(readMobile(ctx.workspace))) };
        if (args.action !== 'replace') throw new Error('Invalid action');
        const current=readMobile(ctx.workspace);
        let candidate=args.project;
        if(candidate&&typeof candidate==='object'&&!Array.isArray(candidate)){
          const proposed=candidate as Record<string,unknown>;
          // Agent replacement must not accidentally drop a user's selected identity.
          if(proposed.designSystem===undefined){
            const profile=current?.designSystem?.profile||chooseDesignProfile(String(proposed.title||''));
            candidate={...proposed,designSystem:{version:1,profile}};
          }
        }
        const project = saveMobile(ctx.workspace, candidate, args.expectedRevision);
        return { ok: true, content: JSON.stringify({ saved: true, ...evidence(project) }) };
      } catch (e) {
        if (e instanceof MobileError && e.status === 409) return { ok: false, content: JSON.stringify({ error: 'Revision conflict. Read the current project again before replacing it.', currentRevision: readMobile(ctx.workspace)?.revision ?? 0 }) };
        return { ok: false, content: e instanceof Error ? e.message : String(e) };
      }
    }
  }];
}

