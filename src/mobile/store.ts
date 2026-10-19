import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { taskPath } from '../server/taskWorkspace.js';
import { DESIGN_PROFILES, type DesignSelection } from '../../ui/mobile-design.js';
import {validateCollections,type MobileCollection} from '../../ui/mobile-data.js';
import {recordVersion,seedVersions,listVersions,versionSnapshot,atomicJson,readCode} from './versions.js';

export type Block = { id: string; type: 'heading' | 'text' | 'button' | 'input' | 'toggle' | 'collection'; text: string; target?: string; help?: string; placeholder?: string; collectionId?:string };
export const mobileIcons = ['book','briefcase','spark','check','sun','flag','note','target'] as const;
export type MobileDesign = { eyebrow: string; description: string; guidance: string; icon: typeof mobileIcons[number] };
export type MobileScreen = { id: string; title: string; group?: string; kind?: 'primary' | 'detail'; parentId?: string; design?: MobileDesign; blocks: Block[] };
export type MobileProject = { version: 1; revision: number; title: string; accent: string; direction: 'rtl' | 'ltr'; designSystem?: DesignSelection; collections?:MobileCollection[]; screens: MobileScreen[] };
export class MobileError extends Error { constructor(message: string, public status = 400) { super(message); } }
const fail = (message: string): never => { throw new MobileError(message); };
function obj(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('Expected an object'); return v as Record<string, unknown>; }
function text(v: unknown, max: number, field = 'Text'): string { if (typeof v !== 'string' || !v.trim() || v.length > max) return fail(`${field} must contain 1–${max} characters`); return v; }
export function validateProject(input: unknown): Omit<MobileProject, 'revision'> {
  const v = obj(input);
  let collections:MobileCollection[];try{collections=validateCollections(v.collections);}catch(e){return fail(e instanceof Error?e.message:String(e));}
  let designSystem: DesignSelection | undefined;
  if(v.designSystem!==undefined){const d=obj(v.designSystem);if(d.version!==1||typeof d.profile!=='string'||!Object.hasOwn(DESIGN_PROFILES,d.profile))fail('Unsupported mobile design profile');designSystem={version:1,profile:d.profile as string};}
  if (v.version !== 1 || !['rtl', 'ltr'].includes(String(v.direction)) || typeof v.accent !== 'string' || !/^#[\da-f]{6}$/i.test(v.accent)) fail('Invalid project version, direction or color');
  if (!Array.isArray(v.screens) || !v.screens.length || v.screens.length > 100) fail('Use between 1 and 100 screens');
  if (Buffer.byteLength(JSON.stringify({ title: v.title, screens: v.screens, collections }), 'utf8') > 2_500_000) fail('Project exceeds 2.5 MB size limit');
  const ids = new Set<string>();
  const id = (value: unknown) => {
    const result = text(value, 80);
    if (!/^[a-z][a-z\d_-]*$/i.test(result)) fail(`Invalid ID ${JSON.stringify(result)}. Use ASCII letters, digits, underscores or hyphens, starting with a letter.`);
    if (ids.has(result)) fail(`Duplicate ID ${JSON.stringify(result)}. Rename this occurrence; every screen and block must have a globally unique ID.`);
    ids.add(result); return result;
  };
  const legacy = (v.screens as unknown[]).every(raw => obj(raw).kind === undefined && obj(raw).parentId === undefined);
  const screens: MobileScreen[] = (v.screens as unknown[]).map((raw, index) => {
    const s = obj(raw), screenId = id(s.id);
    if (!Array.isArray(s.blocks) || s.blocks.length > 60) fail('Maximum 60 blocks per screen');
    const blocks = (s.blocks as unknown[]).map(rawBlock => {
      const b = obj(rawBlock);
      if (!['heading', 'text', 'button', 'input', 'toggle', 'collection'].includes(String(b.type))) fail('Unsupported block type');
      if(b.type==='collection'&&!collections.some(c=>c.id===b.collectionId))fail('Collection block requires an existing collectionId');
      if(b.collectionId!==undefined&&b.type!=='collection')fail('Only collection blocks use collectionId');
      if (b.target !== undefined && (b.type !== 'button' || typeof b.target !== 'string')) fail('Only buttons support navigation targets');
      if (b.placeholder !== undefined && b.type !== 'input') fail('Only inputs support placeholders');
      return { id: id(b.id), type: b.type as Block['type'], text: text(b.text, 2000, `Block ${JSON.stringify(b.id)} text (label, including input and toggle blocks)`), ...(b.target ? { target: text(b.target, 80) } : {}), ...(b.help !== undefined ? { help: text(b.help, 180, 'Field help') } : {}), ...(b.placeholder !== undefined ? { placeholder: text(b.placeholder, 120, 'Placeholder') } : {}), ...(b.type==='collection'?{collectionId:String(b.collectionId)}:{}) };
    });
    const kind = s.kind ?? (legacy ? (index < 5 ? 'primary' : 'detail') : undefined);
    if (kind !== 'primary' && kind !== 'detail') fail(`Screen ${screenId}: kind must be primary or detail`);
    const parentId = legacy && index >= 5 ? String(obj((v.screens as unknown[])[0]).id) : s.parentId;
    if (kind === 'primary' && parentId !== undefined) fail(`Primary screen ${screenId} cannot have a parent`);
    if (kind === 'detail' && (typeof parentId !== 'string' || !parentId)) fail(`Detail screen ${screenId} requires parentId`);
    let design: MobileDesign | undefined;
    if (s.design !== undefined) { const d = obj(s.design); if (!mobileIcons.includes(d.icon as MobileDesign['icon'])) fail('Unsupported design icon'); design = { eyebrow: text(d.eyebrow, 60, 'Eyebrow'), description: text(d.description, 220, 'Screen description'), guidance: text(d.guidance, 240, 'Guidance'), icon: d.icon as MobileDesign['icon'] }; }
    return { id: screenId, title: text(s.title, 120), group: s.group === undefined ? 'عام' : text(s.group, 80, 'Group name'), kind: kind as MobileScreen['kind'], ...(parentId ? { parentId: String(parentId) } : {}), ...(design ? { design } : {}), blocks };
  });
  const primary = screens.filter(s => s.kind === 'primary');
  if (!primary.length || primary.length > 5) fail('Use between 1 and 5 primary sections; other screens must be detail pages');
  const byId = new Map(screens.map(s => [s.id, s]));
  for (const screen of screens) {
    const seen = new Set<string>(); let current: MobileScreen | undefined = screen;
    while (current?.parentId) {
      if (seen.has(current.id)) fail(`Parent cycle at ${current.id}`);
      seen.add(current.id);
      const parent: MobileScreen | undefined = byId.get(current.parentId);
      if (!parent) fail(`Parent ${current.parentId} does not exist`);
      current = parent;
    }
  }
  for (const s of screens) for (const b of s.blocks) if (b.target && !screens.some(s => s.id === b.target)) fail('Navigation target does not exist');
  return { version: 1, title: text(v.title, 160), accent: String(v.accent), direction: v.direction as 'rtl' | 'ltr', ...(designSystem?{designSystem}:{}), ...(collections.length?{collections}:{}), screens };
}
export function readMobile(root: string): MobileProject | null {
  const file = taskPath(root, '.loam/mobile.json');
  if (!fs.existsSync(file)) return null;
  if (fs.statSync(file).size > 30_000_000) fail('Project exceeds size limit');
  let v: Record<string, unknown>;
  try { v = obj(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return fail('Saved project is invalid'); }
  if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 1) fail('Invalid revision');
  return { ...validateProject(v), revision: Number(v.revision) };
}
type History = { past: MobileProject[]; future: MobileProject[] };
function history(root: string): History {
  const file = taskPath(root, '.loam/mobile.json');
  if (!fs.existsSync(file)) return { past: [], future: [] };
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { past: (v.history?.past ?? []).slice(-8), future: (v.history?.future ?? []).slice(-8) };
}
export function mobileHistory(root: string) { const h = history(root); return { canUndo: h.past.length > 0, canRedo: h.future.length > 0 }; }
export function checkCollectionCompatibility(current:Pick<MobileProject,'collections'>|null,clean:Pick<MobileProject,'collections'>){
 for(const before of current?.collections||[]){const after=clean.collections?.find(c=>c.id===before.id);if(!after)continue;for(const field of before.fields){const changed=after.fields.find(f=>f.id===field.id);if(!changed)continue;if(changed.type!==field.type||(field.type==='relation'&&changed.collectionId!==field.collectionId)||(field.type==='select'&&field.options?.some(value=>!changed.options?.includes(value))))fail('نوع الحقل وخياراته الحالية محفوظة لحماية السجلات. أضف حقلًا جديدًا أو خيارات إضافية؛ تحويل البيانات يحتاج ترحيلًا صريحًا.');}}
}
function write(root: string, project: MobileProject, h: History, label?:string): MobileProject {
  const file = taskPath(root, '.loam/mobile.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = taskPath(root, `.loam/mobile-${randomUUID()}.tmp`);
  try { fs.writeFileSync(temp, JSON.stringify({ ...project, history: h }), { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  recordVersion(root,project,label);
  return project;
}
export function saveMobile(root: string, input: unknown, expected: unknown,label?:string): MobileProject {
  if (!Number.isSafeInteger(expected) || Number(expected) < 0) fail('expectedRevision is required');
  const clean = validateProject(input), current = readMobile(root);
  if ((current?.revision ?? 0) !== expected) throw new MobileError('تغيّر المشروع في جلسة أخرى. احفظ نسخة JSON ثم أعد تحميل النسخة الحالية.', 409);
  checkCollectionCompatibility(current,clean);
  if(current)seedVersions(root,current);
  if (current && JSON.stringify(clean) === JSON.stringify(validateProject(current))) return current;
  return write(root, { ...clean, revision: Number(expected) + 1 }, { past: [...history(root).past, ...(current ? [current] : [])].slice(-8), future: [] },label);
}
export function touchMobile(root:string,expected:unknown,label:string){
 const current=readMobile(root);if(!current||current.revision!==expected)throw new MobileError('تغيّر المشروع. أعد تحميله قبل الحفظ.',409);
 seedVersions(root,current);return write(root,{...current,revision:current.revision+1},{past:[...history(root).past,current].slice(-8),future:[]},label);
}
export function travelMobile(root: string, expected: unknown, direction: 'undo' | 'redo'): MobileProject {
  const current = readMobile(root);
  if (!current || current.revision !== expected) throw new MobileError('تغيّر المشروع. أعد تحميله قبل استعادة النسخة.', 409);
  const h = history(root), source = direction === 'undo' ? h.past : h.future, target = source.pop();
  if (!target) throw new MobileError('لا توجد نسخة لاستعادتها.');
  (direction === 'undo' ? h.future : h.past).push(current);
  seedVersions(root,current);
  const archived=listVersions(root).findLast(v=>v.revision===target.revision),before=readCode(root);
  if(archived)atomicJson(root,'.loam/mobile-code.json',versionSnapshot(root,archived.id).code);
  try{return write(root, { ...validateProject(target), revision: current.revision + 1 }, h,direction==='undo'?'تراجع عن تغيير':'إعادة تغيير');}
  catch(e){atomicJson(root,'.loam/mobile-code.json',before);throw e;}
}
