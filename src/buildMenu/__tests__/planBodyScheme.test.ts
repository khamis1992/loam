import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILD_KINDS, type BuildKind } from '../../../packages/shared/src/buildMenu.js';
import { kindPlanContract } from '../planGate.js';
import { assertPlanBody, recordPlanProvenance, writeStoredBrief } from '../planProvenance.js';

const SCHEMES = ['mailto', 'tel', 'sms', 'intent', 'market'] as const;

function encodeOnce(value: string): string {
  return Array.from(value, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
}

function bodyWith(brief: string): string {
  return `${JSON.stringify({
    source: 'loam',
    model: false,
    kind: 'website',
    brief,
    acceptance: 'الصفحة المحلية تعمل بلا شبكة.',
    allowedFiles: ['app/preview.html'],
    permissions: 'لا دفع ولا مفاتيح ولا سكربت تثبيت.',
    userBriefSha256: null,
  })}\n`;
}

function rejected(body: string): void {
  assert.throws(
    () => assertPlanBody(body),
    (error: unknown) => error instanceof Error && error.message === 'invalid_request',
    body,
  );
}

function planFile(workspace: string): string {
  return path.join(workspace, '.loam', 'build-menu', 'plan.json');
}

function briefFile(workspace: string): string {
  return path.join(workspace, '.loam', 'build-menu', 'brief.txt');
}

test('plan json body rejects mailto, tel, sms, intent, and market, including percent-encoding once', () => {
  for (const scheme of SCHEMES) {
    const payload = scheme === 'mailto' ? 'user@example.com' : '+97455500000';
    const literal = `${scheme}:${payload}`;
    const samples = [
      literal,
      `${scheme.toUpperCase()}:${payload}`,
      `${scheme.slice(0, 1).toUpperCase()}${scheme.slice(1)}:${payload}`,
      `${scheme} :${payload}`,
      `${scheme}%3a${payload}`,
      `${scheme.toUpperCase()}%3A${payload}`,
      encodeURIComponent(literal),
      encodeOnce(literal),
      encodeOnce(literal).toUpperCase(),
      `انظر ${scheme}%3a${payload} الآن`,
      `انظر ${encodeOnce(`${scheme}:`)} الآن`,
    ];
    for (const sample of samples) {
      rejected(bodyWith(sample));
    }
  }
  rejected(bodyWith('intent:#Intent;end'));
  rejected(bodyWith('market://details?id=com.example.app'));
  rejected(bodyWith('intent%3A%2F%2Fscan'));
  rejected(bodyWith('market%3A%2F%2Fdetails'));
});

test('plan json body still rejects Manus, https, and the command key', () => {
  rejected(bodyWith('Manus يكتب الخطة'));
  rejected(bodyWith('راجع https://example.test قبل البناء'));
  rejected(bodyWith('راجع http://example.test قبل البناء'));
  rejected(`${JSON.stringify({ source: 'loam', command: 'npm ci' })}\n`);
  assert.doesNotThrow(() => assertPlanBody(bodyWith('hotel: downtown and supermarket: open')));
  assert.doesNotThrow(() => assertPlanBody(bodyWith('note 100% done')));
  assert.doesNotThrow(() => assertPlanBody(bodyWith('صفحة محلية بلا عنوان بعيد')));
});

function storedSeparately(kind: BuildKind, raw: string, forbidden: RegExp): void {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-plan-body-'));
  const trimmed = raw.trim();
  try {
    writeStoredBrief(workspace, raw);
    recordPlanProvenance(workspace, kind);
    const plan = fs.readFileSync(planFile(workspace), 'utf8');
    const saved = JSON.parse(plan) as { userBriefSha256: string | null; brief: string; model: boolean; source: string };
    const contract = kindPlanContract(kind);
    assert.equal(saved.source, 'loam');
    assert.equal(saved.model, false);
    assert.equal(saved.brief, contract.brief);
    assert.equal(saved.userBriefSha256, createHash('sha256').update(trimmed).digest('hex'));
    assert.notEqual(saved.userBriefSha256, createHash('sha256').update(raw).digest('hex'));
    assert.equal(plan.includes(trimmed), false);
    assert.equal(forbidden.test(plan), false);
    assert.equal(fs.readFileSync(briefFile(workspace), 'utf8'), `${trimmed}\n`);
    assert.equal(forbidden.test(trimmed), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test('a brief containing mailto stays in brief.txt only', () => {
  storedSeparately('website', '  راسل mailto:user@example.com من هذه الصفحة المحلية  ', /mailto/i);
  storedSeparately('notebook', '  راسل mailto%3auser@example.com من هذه الصفحة المحلية  ', /mailto|%3a/i);
  storedSeparately('desktop', `  راسل ${encodeOnce('mailto:user@example.com')} من هذه الصفحة المحلية  `, /mailto|%3a/i);
  for (const scheme of SCHEMES) {
    storedSeparately('widget', `  افتح ${scheme}:${scheme === 'mailto' ? 'user@example.com' : '+97455500000'} من الصفحة  `, new RegExp(scheme, 'i'));
    storedSeparately('game', `  افتح ${scheme}%3apayload من هذه الصفحة المحلية  `, new RegExp(`${scheme}|%3a`, 'i'));
  }
});

test('an ordinary local brief still records a hash', () => {
  const raw = '  صفحة محلية بلا عنوان بعيد للمستخدم  ';
  const trimmed = raw.trim();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-plan-body-local-'));
  try {
    for (const kind of BUILD_KINDS) {
      const workspace = path.join(root, kind);
      fs.mkdirSync(workspace);
      writeStoredBrief(workspace, raw);
      recordPlanProvenance(workspace, kind);
      const plan = fs.readFileSync(planFile(workspace), 'utf8');
      const saved = JSON.parse(plan) as { userBriefSha256: string | null; brief: string };
      assert.equal(saved.userBriefSha256, createHash('sha256').update(trimmed).digest('hex'), kind);
      assert.equal(saved.brief, kindPlanContract(kind).brief, kind);
      assert.equal(plan.includes(trimmed), false, kind);
      assert.equal(/mailto\s*:|tel\s*:|sms\s*:|intent\s*:|market\s*:|%3a/i.test(plan), false, kind);
      assert.equal(fs.readFileSync(briefFile(workspace), 'utf8'), `${trimmed}\n`, kind);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
