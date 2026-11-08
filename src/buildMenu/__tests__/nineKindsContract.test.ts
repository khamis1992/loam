import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BUILD_KINDS,
  type BuildKind,
  type BuildSelection,
  type WebsiteSubtype,
} from '../../../packages/shared/src/buildMenu.js';
import { listProfiles, profileFor } from '../catalog.js';

const NINE_KINDS = [
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

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogSource = fs.readFileSync(path.join(here, '..', 'catalog.ts'), 'utf8');
const sharedSource = fs.readFileSync(
  path.join(here, '..', '..', '..', 'packages', 'shared', 'src', 'buildMenu.ts'),
  'utf8',
);

const SPARKLES = /Sparkles|✨|★/;

test('listProfiles is exactly the nine build kinds', () => {
  const profiles = listProfiles();
  const kinds = profiles.map((profile) => profile.kind);
  assert.equal(profiles.length, 9);
  assert.equal(BUILD_KINDS.length, 9);
  assert.equal(new Set(kinds).size, 9);
  assert.deepEqual(kinds, [...NINE_KINDS]);
  assert.deepEqual([...BUILD_KINDS], [...NINE_KINDS]);
});

test('chatbot is a website subtype and not a card', () => {
  const chatbot: WebsiteSubtype = 'chatbot';
  const selection: BuildSelection = { kind: 'website', subtype: chatbot };
  assert.equal(selection.kind, 'website');
  assert.equal(selection.subtype, 'chatbot');
  assert.equal((BUILD_KINDS as readonly string[]).includes('chatbot'), false);
  assert.equal(listProfiles().some((profile) => (profile.kind as string) === 'chatbot'), false);
  assert.equal(listProfiles().filter((profile) => profile.kind === 'website').length, 1);
  assert.match(
    sharedSource,
    /export type WebsiteSubtype = 'landing' \| 'store' \| 'booking' \| 'chatbot';/,
  );
  assert.equal(catalogSource.includes('chatbot'), false);
  assert.throws(() => profileFor('chatbot' as BuildKind), /missing_requirement:chatbot/);
});

test('catalog cards have no Sparkles icon', () => {
  assert.equal(SPARKLES.test(catalogSource), false);
  assert.equal(SPARKLES.test(sharedSource), false);
  assert.equal(SPARKLES.test(JSON.stringify(listProfiles())), false);
});
