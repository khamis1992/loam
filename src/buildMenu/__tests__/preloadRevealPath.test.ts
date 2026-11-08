/**
 * The desktop reveal bridge must not accept a caller path. This reads
 * electron/preload.cjs and calls buildMenu.revealArtifact with Electron mocked.
 * It does not launch Electron.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/preloadRevealPath.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const preloadPath = fileURLToPath(new URL('../../../electron/preload.cjs', import.meta.url));
const projectId = 'app_bcdfghjkmnpq';
const artifactId = 'art_01234567-89ab-cdef-0123-456789abcdef';

type IpcBody = { ns?: string; method?: string; args?: unknown[] };

function collectStrings(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') {
    found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, found);
  }
  return found;
}

function loadReveal(source: string): {
  reveal: (payload: unknown) => unknown;
  sent: () => IpcBody[];
} {
  const sent: IpcBody[] = [];
  const exposed: Record<string, unknown> = {};
  const sandbox = {
    require(id: string) {
      if (id !== 'electron') throw new Error(`unexpected require: ${id}`);
      return {
        contextBridge: {
          exposeInMainWorld(name: string, value: unknown) {
            exposed[name] = value;
          },
        },
        ipcRenderer: {
          invoke(_channel: string, body: IpcBody) {
            sent.push(body);
            return Promise.resolve(undefined);
          },
          sendSync() {
            return {};
          },
          on() {
            return undefined;
          },
          removeListener() {
            return undefined;
          },
        },
      };
    },
  };
  vm.runInNewContext(source, sandbox, { filename: preloadPath });
  const apis = exposed.__apis as { buildMenu?: { revealArtifact?: (payload: unknown) => unknown } } | undefined;
  const reveal = apis?.buildMenu?.revealArtifact;
  assert.equal(typeof reveal, 'function');
  return { reveal: reveal as (payload: unknown) => unknown, sent: () => sent };
}

test('the reveal bridge does not accept an absolute caller path', () => {
  const source = fs.readFileSync(preloadPath, 'utf8');
  assert.equal(path.basename(preloadPath), 'preload.cjs');
  assert.match(source, /revealArtifact/);
  const { reveal, sent } = loadReveal(source);
  const absolute = path.resolve(path.parse(preloadPath).root, 'outside-workspace', 'secret.zip');
  const posixAbsolute = '/outside-workspace/secret.zip';
  const outside = `..${path.sep}..${path.sep}outside-workspace${path.sep}secret.zip`;
  assert.equal(path.isAbsolute(absolute), true);
  assert.equal(path.win32.isAbsolute(posixAbsolute), true);
  assert.equal(path.isAbsolute(outside), false);
  assert.equal(outside.includes('..'), true);

  assert.throws(() => reveal(absolute), /invalid_request/);
  assert.throws(() => reveal(posixAbsolute), /invalid_request/);
  assert.throws(() => reveal(outside), /invalid_request/);
  assert.throws(() => reveal({ projectId: absolute, artifactId }), /invalid_request/);
  assert.throws(() => reveal({ projectId, artifactId: absolute }), /invalid_request/);
  assert.throws(() => reveal({ projectId: posixAbsolute, artifactId }), /invalid_request/);
  assert.throws(() => reveal({ projectId, artifactId: outside }), /invalid_request/);
  assert.throws(() => reveal({ projectId: outside, artifactId }), /invalid_request/);
  assert.throws(() => reveal({ projectId, artifactId, path: absolute }), /invalid_request/);
  assert.throws(() => reveal({ projectId, artifactId, file: outside }), /invalid_request/);
  assert.equal(sent().length, 0);

  const accepted = reveal({ projectId, artifactId });
  assert.equal(typeof (accepted as Promise<unknown>)?.then, 'function');
  assert.equal(sent().length, 1);
  const body = JSON.parse(JSON.stringify(sent()[0])) as IpcBody;
  assert.equal(body.ns, 'buildMenu');
  assert.equal(body.method, 'revealArtifact');
  assert.deepEqual(body.args, [{ projectId, artifactId }]);
  const forwarded = collectStrings(body);
  for (const value of forwarded) {
    assert.equal(path.win32.isAbsolute(value), false);
    assert.equal(path.posix.isAbsolute(value), false);
    assert.equal(value.includes('..'), false);
    assert.equal(value.includes('outside-workspace'), false);
  }
});
