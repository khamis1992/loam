import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILD_KINDS, type BuildKind, type BuildSelection } from '../../../packages/shared/src/buildMenu.js';
import { sourceEntries } from '../artifacts.js';
import { materialize } from '../materialize.js';
import { kindPlanContract } from '../planGate.js';
import { recordPlanProvenance, writeStoredBrief } from '../planProvenance.js';

function selection(kind: BuildKind): BuildSelection {
  switch (kind) {
    case 'website':
      return { kind, subtype: 'landing' };
    case 'desktop':
    case 'widget':
    case 'automation':
    case 'notebook':
    case 'mobile':
    case 'chrome-extension':
    case 'safari-extension':
    case 'game':
      return { kind };
    default: {
      const unknown: never = kind;
      throw new Error(String(unknown));
    }
  }
}

test('generate records a Loam plan and does not copy a model prompt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-plan-provenance-'));
  try {
    for (const kind of BUILD_KINDS) {
      const workspace = path.join(root, kind);
      fs.mkdirSync(workspace);
      materialize({ selection: selection(kind), workspace, title: 'مشروع' });
      const file = path.join(workspace, '.loam', 'build-menu', 'plan.json');
      const stat = fs.lstatSync(file);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.isSymbolicLink(), false);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        source: string;
        model: boolean;
        kind: string;
        brief: string;
        acceptance: string;
        allowedFiles: string[];
        permissions: string;
        userBriefSha256: string | null;
      };
      const contract = kindPlanContract(kind);
      assert.equal(saved.source, 'loam');
      assert.equal(saved.model, false);
      assert.equal(saved.kind, kind);
      assert.equal(saved.brief, contract.brief);
      assert.equal(saved.acceptance, contract.acceptance);
      assert.deepEqual(saved.allowedFiles, [...contract.allowedFiles]);
      assert.equal(saved.permissions, contract.permissions);
      assert.equal(saved.userBriefSha256, null);
      assert.equal(fs.readFileSync(file, 'utf8').includes('Manus'), false);
      const names = sourceEntries(path.join(workspace, 'app')).map((entry) => entry.name);
      assert.equal(names.includes('plan.json'), false);
    }
    const blocked = path.join(root, 'blocked');
    fs.mkdirSync(path.join(blocked, '.loam'), { recursive: true });
    fs.writeFileSync(path.join(blocked, '.loam', 'build-menu'), 'not-a-directory');
    assert.throws(() => materialize({ selection: { kind: 'notebook' }, workspace: blocked, title: 'دفتر' }), /unsafe_path/);
    assert.equal(fs.existsSync(path.join(blocked, '.loam', 'build-menu', 'plan.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function previewFile(kind: BuildKind): string {
  switch (kind) {
    case 'website':
    case 'automation':
    case 'notebook':
      return 'app/preview.html';
    case 'desktop':
    case 'widget':
      return 'app/dist/index.html';
    case 'mobile':
      return 'app/simulation.html';
    case 'chrome-extension':
    case 'safari-extension':
      return 'app/popup.html';
    case 'game':
      return 'app/index.html';
    default: {
      const unknown: never = kind;
      throw new Error(String(unknown));
    }
  }
}

test('each generated page shows a local brief and hides a remote one', () => {
  const local = 'موجز محلي بلا عنوان بعيد';
  const remote = 'راجع https://example.test قبل البناء';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-brief-pages-'));
  try {
    for (const kind of BUILD_KINDS) {
      const safeRoot = path.join(root, `${kind}-local`);
      const hiddenRoot = path.join(root, `${kind}-remote`);
      fs.mkdirSync(safeRoot);
      fs.mkdirSync(hiddenRoot);
      writeStoredBrief(safeRoot, local);
      writeStoredBrief(hiddenRoot, remote);
      materialize({ selection: selection(kind), workspace: safeRoot, title: 'مشروع' });
      materialize({ selection: selection(kind), workspace: hiddenRoot, title: 'مشروع' });
      const shown = fs.readFileSync(path.join(safeRoot, ...previewFile(kind).split('/')), 'utf8');
      const hidden = fs.readFileSync(path.join(hiddenRoot, ...previewFile(kind).split('/')), 'utf8');
      assert.match(shown, new RegExp(`id="brief"[^>]*>${local}`));
      assert.equal(hidden.includes('https://'), false);
      assert.match(hidden, /لم يُعرض في الصفحة لأنه يحتوي عنواناً بعيداً/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stored brief is hashed into the plan and its text stays out of the plan file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-plan-brief-'));
  try {
    const brief = 'صفحة محلية تذكر https://example.test ولا تُنفذها';
    writeStoredBrief(root, brief);
    recordPlanProvenance(root, 'website');
    const file = path.join(root, '.loam', 'build-menu', 'plan.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { userBriefSha256: string; model: boolean };
    assert.equal(saved.model, false);
    assert.equal(saved.userBriefSha256, createHash('sha256').update(brief).digest('hex'));
    assert.equal(fs.readFileSync(file, 'utf8').includes('https://'), false);
    assert.equal(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'brief.txt'), 'utf8').includes(brief), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
