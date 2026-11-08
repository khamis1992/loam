import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactHeaders, downloadName } from '../artifacts.js';
import { BuildMenuError } from '../grants.js';

const artifactId = 'art_01234567-89ab-cdef-0123-456789abcdef';

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'invalid_request' && error.status === 400;
}

test('a download name is a basename and its disposition is one header', () => {
  for (const extension of ['.zip', '.ipynb', '.apk']) {
    const name = downloadName(`${artifactId}${extension}`);
    assert.equal(name, `${artifactId}${extension}`);
    const disposition = String(artifactHeaders(artifactId, 8, name)['content-disposition']);
    assert.equal(disposition, `attachment; filename="${name}"`);
    assert.equal(disposition.split(/\r\n|\n|\r/).length, 1);
    assert.equal(disposition.includes('\r'), false);
    assert.equal(disposition.includes('\n'), false);
    assert.equal(disposition.match(/filename=/g)?.length, 1);
  }
});

test('quotes, carriage returns, line feeds, and path separators are refused', () => {
  const samples = [
    '"report.zip',
    "report'.zip",
    'report.zip"\r\nSet-Cookie: a=b',
    'report.zip\r\nX-Injected: 1',
    'report.zip\nX-Injected: 1',
    'report.zip\rX-Injected: 1',
    `dir/${artifactId}.zip`,
    `dir\\${artifactId}.zip`,
    `../${artifactId}.zip`,
    `..\\${artifactId}.zip`,
    `${artifactId}.zip"`,
    "'notes.zip'",
    '.',
    '..',
    '',
  ];
  for (const sample of samples) {
    assert.throws(() => downloadName(sample), refused);
    assert.throws(() => artifactHeaders(artifactId, 1, sample), refused);
  }
});
