import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('the desktop template page keeps scripts and styles local', () => {
  const html = fs.readFileSync(path.resolve('src/templates/electron-app/renderer/index.html'), 'utf8');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /style-src 'self'/);
  assert.equal(html.includes('unsafe-inline'), false);
  assert.equal(html.includes('unsafe-eval'), false);
  assert.equal(/https?:\/\//i.test(html), false);
  assert.match(html, /src="\.\/app\.ts"/);
  assert.match(html, /href="\.\/styles\.css"/);
});
