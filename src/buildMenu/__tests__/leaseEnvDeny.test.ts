import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildMenuError } from '../grants.js';
import { leaseEnv } from '../processLease.js';

const BOOT_KEYS = ['PATH', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'SYSTEMROOT', 'WINDIR'] as const;
const INJECTED = ['NODE_OPTIONS', 'LD_PRELOAD', 'ELECTRON_RUN_AS_NODE'] as const;
const RELATIVE_READY = '.loam/build-menu/window-ready';

function refuses(toolchain: Record<string, string>, label: string): void {
  let copied: NodeJS.ProcessEnv | undefined;
  assert.throws(
    () => {
      copied = leaseEnv(toolchain);
    },
    (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    label,
  );
  assert.equal(copied, undefined, label);
}

test('leaseEnv copies boot keys and a relative toolchain file', () => {
  const env = leaseEnv({ LOAM_PREVIEW_READY: RELATIVE_READY });
  assert.equal(env.LOAM_PREVIEW_READY, RELATIVE_READY);
  const allowed = new Set<string>([...BOOT_KEYS, 'LOAM_PREVIEW_READY']);
  for (const key of Object.keys(env)) assert.equal(allowed.has(key), true, key);
  for (const key of BOOT_KEYS) {
    const value = process.env[key];
    if (value) assert.equal(env[key], value);
    else assert.equal(env[key], undefined);
  }
});

test('leaseEnv does not copy NODE_OPTIONS, LD_PRELOAD, or ELECTRON_RUN_AS_NODE', () => {
  const previous = new Map(INJECTED.map((key) => [key, process.env[key]] as const));
  process.env.NODE_OPTIONS = '--require ./evil.js';
  process.env.LD_PRELOAD = './evil.so';
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const env = leaseEnv({ LOAM_PREVIEW_READY: RELATIVE_READY });
    assert.equal(env.LOAM_PREVIEW_READY, RELATIVE_READY);
    for (const key of INJECTED) {
      assert.equal(Object.hasOwn(env, key), false, key);
      assert.equal(env[key], undefined, key);
    }
    const flat = Object.values(env).join('\n');
    assert.equal(flat.includes('--require ./evil.js'), false);
    assert.equal(flat.includes('./evil.so'), false);
    assert.equal(flat.includes('ELECTRON_RUN_AS_NODE'), false);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  for (const [key, value] of previous) assert.equal(process.env[key], value);
});

test('leaseEnv rejects toolchain values that carry secrets, grant assignments, or remote schemes', () => {
  const values = [
    'sk-testsecretvalue',
    'prefix SK-abc',
    'Bearer abc.def',
    'x bearer y',
    'AIzaSyExampleKey',
    'aiza-prefix',
    'grantId=abc123',
    'grant_id = abc123',
    'grant-id:abc123',
    'note GRANTID=abc',
    'https://evil.example/a.js',
    'see HTTPS://evil.example',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
  ];
  for (const value of values) refuses({ LOAM_PREVIEW_READY: value }, value);
  const env = leaseEnv({ LOAM_PREVIEW_READY: RELATIVE_READY });
  assert.equal(env.LOAM_PREVIEW_READY, RELATIVE_READY);
  assert.equal(JSON.stringify(env).includes('sk-'), false);
});

test('leaseEnv rejects toolchain keys that contain secret, token, key, password, or api', () => {
  for (const key of ['secret', 'MY_SECRET', 'token', 'ACCESS_TOKEN', 'key', 'private_key', 'password', 'DB_PASSWORD', 'api', 'OPENAI_API_KEY']) {
    refuses({ [key]: RELATIVE_READY }, key);
  }
  const env = leaseEnv({ LOAM_PREVIEW_READY: 'grants/ready.txt' });
  assert.equal(env.LOAM_PREVIEW_READY, 'grants/ready.txt');
});
