import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { validateProject } from '../../mobile/store.js';
import { materialize } from '../materialize.js';
import { starterMobile } from '../mobile/fixture.js';
import { createMobilePorts } from '../mobile/ports.js';
import { simulationDocument } from '../mobile/simulation.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { codeTag, readCode } from '../../mobile/versions.js';
import { readMobile } from '../../mobile/store.js';
import { saveSource } from '../../mobile/source.js';

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'mobile' };
  return {
    workspace,
    jobId: 'job_mobile_source_guard',
    operation: { action: 'package', format: 'source-zip' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'جوال',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

async function archiveText(bytes: Buffer): Promise<{ names: string[]; text: string }> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir);
  const parts: string[] = [];
  for (const name of names) {
    parts.push(name);
    const entry = zip.file(name);
    if (entry) parts.push(await entry.async('string'));
  }
  return { names, text: parts.join('\n') };
}

test('mobile source export drops secret-looking files and refuses a remote script in a web or expo page', async () => {
  const label = simulationDocument({ ...validateProject(starterMobile()), revision: 1 });
  assert.match(label, /محاكاة الويب — ليست محاكياً أصلياً\. تصدير المصدر ليس ملف APK/);
  assert.equal(/emulator/i.test(label), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-mobile-source-'));
  const ports = createMobilePorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'mobile' }, workspace: root, title: 'جوال' });
    let project = readMobile(root);
    assert.ok(project);
    project = saveSource(root, 'expo/google-services.json', '{"project_id":"loam-secret-services"}\n', project.revision, codeTag(readCode(root)));
    project = saveSource(root, 'android/local.properties', 'sdk.dir=C:\\\\Users\\\\loam-secret-sdk\\\\Android\\\\Sdk\n', project.revision, codeTag(readCode(root)));
    project = saveSource(root, 'expo/credentials.json', '{"note":"loam-credentials-file"}\n', project.revision, codeTag(readCode(root)));
    project = saveSource(root, 'android/app/secret.properties', 'api_key=sk-loamsecretvalue\n', project.revision, codeTag(readCode(root)));
    project = saveSource(root, 'expo/kept.json', '{"note":"loam-kept-note"}\n', project.revision, codeTag(readCode(root)));
    const artifact = await ports.export(context(root), 'source-zip');
    const zipPath = path.join(root, artifact.relativePath);
    const bytes = fs.readFileSync(zipPath);
    const packed = await archiveText(bytes);
    assert.equal(packed.names.some((name) => name.endsWith('.apk')), false);
    assert.equal(packed.names.includes('index.html'), true);
    assert.equal(packed.names.includes('expo/App.js'), true);
    assert.match(packed.text, /not an APK/);
    assert.match(packed.text, /mountMobile/);
    assert.match(packed.text, /loam-kept-note/);
    assert.equal(packed.text.includes('loam-secret-services'), false);
    assert.equal(packed.text.includes('loam-secret-sdk'), false);
    assert.equal(packed.text.includes('loam-credentials-file'), false);
    assert.equal(packed.text.includes('sk-loamsecretvalue'), false);
    assert.equal(packed.names.includes('expo/google-services.json'), false);
    assert.equal(packed.names.includes('android/local.properties'), false);
    assert.equal(packed.names.includes('expo/credentials.json'), false);
    assert.equal(packed.names.includes('android/app/secret.properties'), false);
    const stored = JSON.stringify(readCode(root).files);
    assert.match(stored, /loam-secret-services/);
    assert.match(stored, /loam-secret-sdk/);
    assert.match(stored, /loam-credentials-file/);
    assert.match(stored, /sk-loamsecretvalue/);

    project = readMobile(root);
    assert.ok(project);
    saveSource(root, 'expo/App.js', 'import "https://evil.example/expo.js";\n', project.revision, codeTag(readCode(root)));
    await assert.rejects(
      ports.export(context(root), 'source-zip'),
      (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
    );
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
    assert.match(JSON.stringify(readCode(root).files), /evil\.example\/expo\.js/);

    project = readMobile(root);
    assert.ok(project);
    const cleared = saveSource(root, 'expo/App.js', '', project.revision, codeTag(readCode(root)), true);
    saveSource(root, 'web/index.html', '<!doctype html><script src="https://evil.example/web.js"></script>', cleared.revision, codeTag(readCode(root)));
    await assert.rejects(
      ports.export(context(root), 'source-zip'),
      (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
    );
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
    assert.match(JSON.stringify(readCode(root).files), /evil\.example\/web\.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mobile source export keeps an svg namespace and refuses a remote formaction or percent-encoded web url', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-mobile-source-form-'));
  const ports = createMobilePorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'mobile' }, workspace: root, title: 'جوال' });
    let project = readMobile(root);
    assert.ok(project);
    const local = '<!doctype html><svg xmlns="http://www.w3.org/2000/svg"></svg><button formaction="#stay">ابق</button>';
    project = saveSource(root, 'web/index.html', local, project.revision, codeTag(readCode(root)));
    const artifact = await ports.export(context(root), 'source-zip');
    const zipPath = path.join(root, artifact.relativePath);
    const bytes = fs.readFileSync(zipPath);
    const packed = await archiveText(bytes);
    assert.equal(packed.names.some((name) => name.endsWith('.apk')), false);
    assert.match(packed.text, /http:\/\/www\.w3\.org\/2000\/svg/);
    assert.match(packed.text, /formaction="#stay"/);

    const remote = '<!doctype html><button type="submit" formaction="//pay.example/checkout">ادفع</button>';
    project = saveSource(root, 'web/index.html', remote, project.revision, codeTag(readCode(root)));
    await assert.rejects(
      ports.export(context(root), 'source-zip'),
      (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
    );
    assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
    assert.match(JSON.stringify(readCode(root).files), /pay\.example\/checkout/);

    const encoded = [
      ['javascript%3Aalert(1)', '<!doctype html><a href="javascript%3Aalert(1)">x</a>'],
      ['https%3A//evil.example/web.js', '<!doctype html><a href="https%3A//evil.example/web.js">x</a>'],
    ];
    for (const [marker, page] of encoded) {
      project = readMobile(root);
      assert.ok(project);
      saveSource(root, 'web/index.html', page, project.revision, codeTag(readCode(root)));
      await assert.rejects(
        ports.export(context(root), 'source-zip'),
        (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
      );
      assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
      assert.equal(JSON.stringify(readCode(root).files).includes(marker), true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
