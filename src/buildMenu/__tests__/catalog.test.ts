import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { BUILD_KINDS, type BuildKind } from '../../../packages/shared/src/buildMenu.js';
import { arabicPromptTemplate, engineFor, listProfiles, profileFor } from '../catalog.js';

const KINDS = [
  'website',
  'desktop',
  'widget',
  'automation',
  'notebook',
  'mobile',
  'chrome-extension',
  'safari-extension',
  'game',
] as const satisfies readonly BuildKind[];

const catalogSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'catalog.ts'),
  'utf8',
);

test('nine profiles and every external effect needs approval', () => {
  const profiles = listProfiles();
  assert.equal(profiles.length, 9);
  assert.equal(new Set(profiles.map((profile) => profile.kind)).size, 9);
  assert.deepEqual(profiles.map((profile) => profile.kind), [...KINDS]);
  assert.deepEqual(profiles.map((profile) => profile.kind), [...BUILD_KINDS]);
  assert.ok(profiles.every((profile) => profile.externalEffects === 'approval-required'));
  assert.equal(profiles.some((profile) => (profile.kind as string) === 'chatbot'), false);
});

test('chatbot stays a website subtype and is not a tenth card', () => {
  const profiles = listProfiles();
  assert.equal(profiles.filter((profile) => profile.kind === 'website').length, 1);
  assert.equal(catalogSource.includes('chatbot'), false);
  assert.throws(() => profileFor('chatbot' as BuildKind), /missing_requirement:chatbot/);
  assert.throws(() => engineFor('chatbot' as BuildKind), /missing_requirement:chatbot/);
});

test('catalog has no Sparkles icon string', () => {
  assert.equal(/Sparkles|✨|★/.test(catalogSource), false);
  assert.equal(/Sparkles|✨|★/.test(JSON.stringify(listProfiles())), false);
});

test('each kind maps to one existing engine and a non-empty export list', () => {
  const profiles = listProfiles();
  assert.equal(engineFor('website'), 'loam-build');
  assert.equal(engineFor('desktop'), 'loam-desktop');
  assert.equal(engineFor('widget'), 'loam-desktop');
  assert.equal(engineFor('automation'), 'loam-schedule');
  assert.equal(engineFor('notebook'), 'notebook-ipynb');
  assert.equal(engineFor('mobile'), 'loam-mobile');
  assert.equal(engineFor('chrome-extension'), 'extension-source');
  assert.equal(engineFor('safari-extension'), 'extension-source');
  assert.equal(engineFor('game'), 'loam-game');
  for (const profile of profiles) {
    assert.equal(profileFor(profile.kind).kind, profile.kind);
    assert.ok(Array.isArray(profile.exports));
    assert.ok(profile.exports.length > 0, profile.kind);
    assert.equal(typeof engineFor(profile.kind), 'string');
    assert.ok(engineFor(profile.kind).length > 0);
  }
});

const LOCAL_FILES: Record<BuildKind, readonly string[]> = {
  website: ['app/preview.html', 'app/loam-website.json'],
  desktop: ['app/dist/index.html'],
  widget: ['app/dist/index.html'],
  automation: ['app/preview.html', 'app/schedule.txt', 'app/README.md'],
  notebook: ['app/notebook.ipynb'],
  mobile: ['app/simulation.html'],
  'chrome-extension': ['app/popup.html', 'app/manifest.json'],
  'safari-extension': ['app/popup.html', 'app/manifest.json'],
  game: ['app/index.html', 'app/tuning.json', 'app/LICENSE', 'app/assets/manifest.json'],
};

const PERMISSION_LIMITS: Record<BuildKind, string> = {
  website: 'لا دفع ولا مفاتيح ولا سكربت تثبيت.',
  desktop: 'لا autostart ولا جسر Loam ولا تنفيذ main مولّد.',
  widget: 'لا طلب شبكة ولا صلاحيات عامة.',
  automation: 'لا إرسال ولا نشر ولا حذف ملفات.',
  notebook: 'لا pip ولا صورة latest ولا شبكة الحاوية.',
  mobile: 'لا sync ولا دفع ولا توقيع متجر.',
  'chrome-extension': 'لا all_urls ولا background ولا تحميل على ملف المستخدم.',
  'safari-extension': 'لا تحويل Xcode على غير macOS ولا رفع متجر.',
  game: 'لا أصول خارجية ولا موسيقى مجهولة الترخيص.',
};

test('each profile has a static Arabic prompt with kind, files, and permission limits', () => {
  assert.equal(listProfiles().length, 9);
  assert.equal(/manus/i.test(catalogSource), false);
  assert.equal(catalogSource.includes('fetch('), false);
  assert.equal(/openai|anthropic|chat\.completions|generateText/i.test(catalogSource), false);
  const route = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'routes', 'buildMenu.ts'),
    'utf8',
  );
  assert.match(route, /if \(p\.endsWith\('\/plan'\)\)/);
  assert.match(route, /generation needs a model provider/);
  for (const profile of listProfiles()) {
    const prompt = arabicPromptTemplate(profile.kind);
    assert.equal(typeof prompt, 'string');
    assert.equal(prompt.constructor !== Promise, true);
    assert.equal(arabicPromptTemplate(profile.kind), prompt);
    assert.match(prompt, /[\u0600-\u06FF]/);
    assert.match(prompt, /قالب تعليمات محلي ثابت/);
    assert.equal(prompt.includes(`النوع: ${profile.kind}.`), true);
    for (const file of LOCAL_FILES[profile.kind]) assert.equal(prompt.includes(file), true);
    assert.equal(prompt.includes(PERMISSION_LIMITS[profile.kind]), true);
    assert.equal(/https:\/\//i.test(prompt), false);
    assert.equal(/javascript:/i.test(prompt), false);
    assert.equal(/manus|مانوس/i.test(prompt), false);
    assert.equal(/(?:ولّ?د|أنشأ|أنتج|كتب)(?:ه|ها|ته)?\s+نموذج|نموذج(?:اً|ا)?\s+(?:ولّ?د|أنشأ|أنتج|كتب)|generated by/i.test(prompt), false);
  }
});
