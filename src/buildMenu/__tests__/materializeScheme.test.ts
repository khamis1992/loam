import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readMobile, saveMobile } from '../../mobile/store.js';
import { materialize, readPreview } from '../materialize.js';

const LOCAL_SCRIPT = [
  'const names = ["mailto", "tel", "sms", "intent", "market"];',
  'const place = "hotel: inn";',
  'const action = "#save";',
  'const src = "./preview.js";',
  '',
].join('\n');

const LOCAL_HTML = [
  '<!doctype html><meta charset="utf-8">',
  '<form action="#save"></form>',
  '<a href="./notes.html">ملاحظة</a>',
  '<textarea>mailto:a@b.c tel:+1 sms:+1 intent:#Intent;end market://details</textarea>',
  '<pre>mailto%3Aa@b.c %6d%61%69%6c%74%6f%3Aa@b.c</pre>',
  '<p>hotel: inn supermarket: aisle</p>',
  '<script src="./preview.js"></script>',
].join('');

const ATTACKS = [
  'mailto:user@example.com',
  'MAILTO:user@example.com',
  'mailto :user@example.com',
  'tel:+97400000000',
  'TEL:+97400000000',
  'sms:+97400000000?body=hi',
  'intent:#Intent;end',
  'market://details?id=com.example.app',
  'mailto%3Auser%40example.com',
  'tel%3A%2B97400000000',
  'sms%3A974',
  'intent%3A%23Intent%3Bend',
  'market%3A%2F%2Fdetails',
  'mailto%253Auser%2540example.com',
  'tel%253A974',
  'sms%253A974',
  'intent%253Ascan',
  'market%253A%252F%252Fdetails',
  '%6d%61%69%6c%74%6f%3auser@example.com',
  '%256d%2561%2569%256c%2574%256f%253auser@example.com',
  '"mailto"+":"',
  "'mailto'+':'",
  '"mailto" + ":"',
  "mailto' + ':",
  '"tel"+":"',
  '"sms" + ":"',
  "'intent' + ':'",
  '"market"+"://details"',
  '"mail"+"to:"',
  "'te'+'l:'",
  '%22mailto%22%2B%22%3A%22',
  '%2522mailto%2522%252B%2522%253A%2522',
  '&quot;mailto&quot;+&quot;:&quot;',
];

function unsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loam-41-materialize-'));
}

function writePair(root: string, html: string, script: string): { htmlPath: string; scriptPath: string } {
  const dir = path.join(root, 'app');
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, 'preview.html');
  const scriptPath = path.join(dir, 'preview.js');
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(scriptPath, script);
  return { htmlPath, scriptPath };
}

function attackHtml(payload: string): string {
  return `<!doctype html><a href="${payload}">x</a><form action="#save"></form><button formaction="${payload}">go</button><script src='${payload}'></script><p>${payload}</p><script src="./preview.js"></script>`;
}

test('local preview.js and action="#save" still pass', () => {
  const root = tempWorkspace();
  try {
    const files = writePair(root, LOCAL_HTML, LOCAL_SCRIPT);
    const htmlBefore = fs.readFileSync(files.htmlPath);
    const scriptBefore = fs.readFileSync(files.scriptPath);
    const shown = readPreview(root, 'app/preview.html') ?? '';
    assert.match(shown, /#save/);
    assert.match(shown, /hotel: inn/);
    assert.match(shown, /\.\/preview\.js/);
    assert.equal(shown.includes('src="./preview.js"'), false);
    assert.deepEqual(fs.readFileSync(files.htmlPath), htmlBefore);
    assert.deepEqual(fs.readFileSync(files.scriptPath), scriptBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scaffolded previews keep local targets and omit handset schemes', () => {
  const desktop = tempWorkspace();
  const widget = tempWorkspace();
  const website = tempWorkspace();
  const game = tempWorkspace();
  const extension = tempWorkspace();
  const automation = tempWorkspace();
  try {
    const desktopResult = materialize({ selection: { kind: 'desktop' }, workspace: desktop, title: 'مكتب' });
    const desktopHtml = fs.readFileSync(path.join(desktop, 'app', 'dist', 'index.html'), 'utf8');
    const desktopScript = fs.readFileSync(path.join(desktop, 'app', 'dist', 'preview.js'), 'utf8');
    assert.match(desktopHtml, /src="\.\/preview\.js"/);
    assert.equal(/(?:mailto|tel|sms|intent|market)\s*:/i.test(desktopHtml), false);
    assert.equal(/(?:mailto|tel|sms|intent|market)\s*:/i.test(desktopScript), false);
    assert.match(readPreview(desktop, desktopResult.relativePreview) ?? '', /لا توجد ملاحظة بعد/);

    materialize({ selection: { kind: 'widget' }, workspace: widget, title: 'ويدجت' });
    assert.match(readPreview(widget, 'app/dist/index.html') ?? '', /id="countdown"/);

    materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace: website, title: 'هبوط' });
    assert.match(readPreview(website, 'app/preview.html') ?? '', /هبوط/);

    materialize({ selection: { kind: 'game' }, workspace: game, title: 'لعبة' });
    const gameHtml = fs.readFileSync(path.join(game, 'app', 'index.html'), 'utf8');
    assert.match(gameHtml, /mailto/);
    assert.equal(/(?:^|[^A-Za-z0-9])(?:mailto|tel|sms|intent|market)\s*:/i.test(gameHtml), false);
    assert.match(readPreview(game, 'app/index.html') ?? '', /function step/);

    materialize({ selection: { kind: 'chrome-extension' }, workspace: extension, title: 'إضافة' });
    assert.match(readPreview(extension, 'app/popup.html') ?? '', /missing_chrome/);

    materialize({ selection: { kind: 'automation' }, workspace: automation, title: 'تقرير' });
    assert.match(readPreview(automation, 'app/preview.html') ?? '', /تقرير محلي/);
  } finally {
    for (const root of [desktop, widget, website, game, extension, automation]) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('preview html and scripts refuse handset schemes, encodings, and quote splits', () => {
  const root = tempWorkspace();
  try {
    const files = writePair(root, LOCAL_HTML, LOCAL_SCRIPT);
    for (const payload of ATTACKS) {
      const htmlBefore = fs.readFileSync(files.htmlPath);
      const scriptBefore = fs.readFileSync(files.scriptPath);
      fs.writeFileSync(files.htmlPath, attackHtml(payload));
      assert.throws(() => readPreview(root, 'app/preview.html'), unsafePath, payload);
      assert.deepEqual(fs.readFileSync(files.htmlPath), Buffer.from(attackHtml(payload)), payload);
      assert.deepEqual(fs.readFileSync(files.scriptPath), scriptBefore, payload);

      fs.writeFileSync(files.htmlPath, htmlBefore);
      fs.writeFileSync(files.scriptPath, payload);
      assert.throws(() => readPreview(root, 'app/preview.html'), unsafePath, `script ${payload}`);
      assert.deepEqual(fs.readFileSync(files.htmlPath), htmlBefore, payload);
      assert.deepEqual(fs.readFileSync(files.scriptPath), Buffer.from(payload), payload);
      fs.writeFileSync(files.scriptPath, scriptBefore);
    }

    for (const payload of ['https://evil.example/a', 'javascript:alert(1)', 'javascript :alert(1)']) {
      fs.writeFileSync(files.htmlPath, attackHtml(payload));
      assert.throws(() => readPreview(root, 'app/preview.html'), unsafePath, payload);
      fs.writeFileSync(files.scriptPath, payload);
      fs.writeFileSync(files.htmlPath, LOCAL_HTML);
      assert.throws(() => readPreview(root, 'app/preview.html'), unsafePath, `script ${payload}`);
    }
    for (const payload of ['data:text/html,hi', 'file:///c:/secret', 'blob:null/uuid']) {
      fs.writeFileSync(files.htmlPath, `<a href="${payload}">x</a><form action="#save"></form><script src="./preview.js"></script>`);
      fs.writeFileSync(files.scriptPath, LOCAL_SCRIPT);
      assert.throws(() => readPreview(root, 'app/preview.html'), unsafePath, payload);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a rejected simulation page leaves the previous file unchanged', () => {
  const root = tempWorkspace();
  try {
    materialize({ selection: { kind: 'mobile' }, workspace: root, title: 'دفتر' });
    const page = path.join(root, 'app', 'simulation.html');
    let project = readMobile(root);
    assert.ok(project);
    saveMobile(root, {
      ...project,
      screens: project.screens.map((screen, index) => index === 0 ? { ...screen, title: 'KEEP-SCREEN' } : screen),
    }, project.revision);
    materialize({ selection: { kind: 'mobile' }, workspace: root, title: 'دفتر' });
    const kept = fs.readFileSync(page);
    assert.match(kept.toString('utf8'), /KEEP-SCREEN/);
    project = readMobile(root);
    assert.ok(project);

    for (const payload of ATTACKS) {
      const current = readMobile(root);
      assert.ok(current);
      const title = payload.slice(0, 80);
      saveMobile(root, {
        ...current,
        title,
        screens: current.screens.map((screen, index) => index === 0 ? { ...screen, title } : screen),
      }, current.revision);
      assert.throws(
        () => materialize({ selection: { kind: 'mobile' }, workspace: root, title: 'دفتر' }),
        unsafePath,
        payload,
      );
      assert.deepEqual(fs.readFileSync(page), kept, payload);
      assert.equal(fs.lstatSync(page).isFile(), true, payload);
      assert.equal(fs.lstatSync(page).isSymbolicLink(), false, payload);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
