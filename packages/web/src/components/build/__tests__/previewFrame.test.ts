import { expect, test } from 'vitest';
import { previewFrame } from '../previewFrame';

const page = 'http://localhost:8787';

test('a separate loopback preview keeps its own origin', () => {
  expect(previewFrame('http://127.0.0.1:9/', page)).toEqual({
    src: 'http://127.0.0.1:9/',
    sandbox: 'allow-scripts allow-same-origin',
  });
  expect(previewFrame('http://localhost:9/index.html', page)?.src).toBe('http://localhost:9/index.html');
});

test('a foreign host and a javascript URL do not produce a frame', () => {
  expect(previewFrame('http://evil.example:9/', page)).toBeNull();
  expect(previewFrame('javascript:alert(1)', page)).toBeNull();
  expect(previewFrame('javascript://127.0.0.1:9/alert(1)', page)).toBeNull();
});

test('file, remote, token, and same-origin previews are not framed', () => {
  expect(previewFrame('file:///C:/secret.html', page)).toBeNull();
  expect(previewFrame('https://evil.example/', page)).toBeNull();
  expect(previewFrame('http://evil.example:9/', page)).toBeNull();
  expect(previewFrame('http://127.0.0.1/', page)).toBeNull();
  expect(previewFrame('http://localhost:8787/app', page)).toBeNull();
  expect(previewFrame('http://user:pass@127.0.0.1:9/', page)).toBeNull();
  expect(previewFrame('http://127.0.0.1:9/?token=secret', page)).toBeNull();
  expect(previewFrame('not a url', page)).toBeNull();
});
