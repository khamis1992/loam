import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { materialize } from '../materialize.js';
import { createMobilePorts } from '../mobile/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { codeTag, readCode } from '../../mobile/versions.js';
import { readMobile } from '../../mobile/store.js';
import { saveSource } from '../../mobile/source.js';

const SAFE_PAGE = '<!doctype html><svg xmlns="http://www.w3.org/2000/svg"></svg><a href="a.html">صفحة</a><link rel="stylesheet" href="./app.css">';

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'mobile' };
  return {
    workspace,
    jobId: 'job_mobile_intent',
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

test('mobile source export packs local pages, drops secrets, and refuses handset and remote urls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-mobile-intent-'));
  const ports = createMobilePorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'mobile' }, workspace: root, title: 'جوال' });
    let project = readMobile(root);
    assert.ok(project);
    project = saveSource(root, 'expo/google-services.json', '{"project_id":"loam-secret-services"}\n', project.revision, codeTag(readCode(root)));
    project = saveSource(root, 'android/local.properties', 'sdk.dir=C:\\\\Users\\\\loam-secret-sdk\\\\Android\\\\Sdk\n', project.revision, codeTag(readCode(root)));
    project = saveSource(root, 'android/app/secret.properties', 'api_key=sk-loamsecretvalue\n', project.revision, codeTag(readCode(root)));
    project = saveSource(root, 'web/a.html', '<!doctype html><p>local-relative-page</p>', project.revision, codeTag(readCode(root)));
    project = saveSource(root, 'web/app.css', 'body{color:#172b35}/* local-relative-css */\n', project.revision, codeTag(readCode(root)));
    saveSource(root, 'web/index.html', SAFE_PAGE, project.revision, codeTag(readCode(root)));

    const artifact = await ports.export(context(root), 'source-zip');
    const zipPath = path.join(root, artifact.relativePath);
    const bytes = fs.readFileSync(zipPath);
    const packed = await archiveText(bytes);
    assert.equal(packed.names.some((name) => name.endsWith('.apk')), false);
    assert.match(packed.text, /not an APK/);
    assert.equal(packed.names.includes('web/a.html'), true);
    assert.equal(packed.names.includes('web/app.css'), true);
    assert.match(packed.text, /local-relative-page/);
    assert.match(packed.text, /local-relative-css/);
    assert.match(packed.text, /href="a\.html"/);
    assert.match(packed.text, /href="\.\/app\.css"/);
    assert.match(packed.text, /http:\/\/www\.w3\.org\/2000\/svg/);
    assert.equal(packed.text.includes('loam-secret-services'), false);
    assert.equal(packed.text.includes('loam-secret-sdk'), false);
    assert.equal(packed.text.includes('sk-loamsecretvalue'), false);
    assert.equal(packed.names.includes('expo/google-services.json'), false);
    assert.equal(packed.names.includes('android/local.properties'), false);
    assert.equal(packed.names.includes('android/app/secret.properties'), false);
    const stored = JSON.stringify(readCode(root).files);
    assert.match(stored, /loam-secret-services/);
    assert.match(stored, /loam-secret-sdk/);
    assert.match(stored, /sk-loamsecretvalue/);

    const attributeUrls = [
      'javascript:alert(1)',
      'https://evil.example/a.js',
      'data:text/html,hi',
      'file:///c:/secret',
      'blob:null/uuid',
    ];
    const attributeTags = [
      (url: string) => `<img src="${url}">`,
      (url: string) => `<a href="${url}">x</a>`,
      (url: string) => `<form action="${url}"></form>`,
    ];
    for (const url of attributeUrls) {
      for (const tag of attributeTags) {
        await rejectPacked(root, ports, zipPath, bytes, 'web/index.html', `<!doctype html>${tag(url)}`, url);
      }
    }

    const schemes = ['intent', 'market', 'mailto', 'tel', 'sms'];
    const encode = [
      (scheme: string) => `${scheme}:open`,
      (scheme: string) => `${scheme}%3Aopen`,
      (scheme: string) => `${scheme}%253Aopen`,
    ];
    for (const scheme of schemes) {
      for (const form of encode) {
        const payload = form(scheme);
        await rejectPacked(root, ports, zipPath, bytes, 'web/index.html', `<!doctype html><p>${payload}</p>`, payload);
        await rejectPacked(root, ports, zipPath, bytes, 'expo/App.js', `export const open = ${JSON.stringify(payload)};\n`, payload);
      }
    }
    await rejectPacked(root, ports, zipPath, bytes, 'expo/App.js', 'export const open = "TEL%3a+15551212";\n', 'TEL%3a+15551212');
    await rejectPacked(root, ports, zipPath, bytes, 'web/index.html', '<!doctype html><p>SMS%253A+15551212</p>', 'SMS%253A+15551212');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function rejectPacked(
  root: string,
  ports: ReturnType<typeof createMobilePorts>,
  zipPath: string,
  bytes: Buffer,
  name: 'web/index.html' | 'expo/App.js',
  content: string,
  marker: string,
) {
  const project = readMobile(root);
  assert.ok(project);
  let revision = project.revision;
  if (name === 'web/index.html') {
    const cleared = saveSource(root, 'expo/App.js', '', revision, codeTag(readCode(root)), true);
    revision = cleared.revision;
  } else {
    const restored = saveSource(root, 'web/index.html', SAFE_PAGE, revision, codeTag(readCode(root)));
    revision = restored.revision;
  }
  saveSource(root, name, content, revision, codeTag(readCode(root)));
  await assert.rejects(
    ports.export(context(root), 'source-zip'),
    (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
  );
  assert.equal(fs.readFileSync(zipPath).equals(bytes), true);
  assert.equal(JSON.stringify(readCode(root).files).includes(marker), true);
}
