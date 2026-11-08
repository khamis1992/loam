import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionFiles } from '../extensions/source.js';
import { conversionCapability, currentConversion, safariPreviewHtml } from '../safari/platform.js';

test('a Safari popup keeps the local script and refuses a remote one', () => {
  assert.equal(conversionCapability('win32', true), 'source-only');
  if (process.platform !== 'darwin') assert.equal(currentConversion(), 'source-only');
  const popup = extensionFiles('ملاحظة').find((file) => file.path === 'popup.html')?.content;
  assert.ok(popup);
  const next = safariPreviewHtml(popup);
  assert.match(next, /id="safari-untested"/);
  assert.match(next, /<script src="popup\.js"><\/script>/);
  assert.equal(/https?:\/\//i.test(next), false);

  const alongside = popup.replace(
    '<script src="popup.js"></script>',
    '<script src="popup.js"></script><script src="//evil.example/a.js"></script>',
  );
  assert.throws(() => safariPreviewHtml(alongside), /unsafe_path/);

  const marked = next.replace('<script src="popup.js"></script>', '<script src="//evil.example/a.js"></script>');
  assert.equal(marked.includes('id="safari-untested"'), true);
  assert.throws(() => safariPreviewHtml(marked), /unsafe_path/);

  const inline = next.replace(
    '<script src="popup.js"></script>',
    '<script src="popup.js"></script><script>import("//cdn.example/a.js")</script>',
  );
  assert.throws(() => safariPreviewHtml(inline), /unsafe_path/);
});
