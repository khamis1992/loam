import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.resolve('scripts/build-menu/safari-inspect.py');

test('Safari inspect refuses this machine before xcodebuild', () => {
  const source = fs.readFileSync(script, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(source.indexOf('unsupported_platform') < source.indexOf('subprocess.check_output'));
  assert.equal(source.includes('codesign'), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-safari-inspect-'));
  fs.mkdirSync(path.join(root, 'LoamPageNotes.xcodeproj'));
  try {
    const result = run(root, []);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unsupported_platform/);
    assert.equal(result.stdout.includes('xcodebuild'), false);
    assert.equal(fs.existsSync(path.join(root, 'DerivedData')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Safari inspect keeps the converter scheme and does not build from a fixture', () => {
  const missing = inspect(['Other']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /converter_scheme_changed/);
  assert.equal(missing.stdout.includes('CODE_SIGNING_ALLOWED=NO'), false);
  assert.equal(missing.built, false);

  const empty = inspect([], 0);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /expected_one_xcode_project/);

  const extra = inspect(['LoamPageNotes'], 2);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /expected_one_xcode_project/);

  const planned = inspect(['LoamPageNotes']);
  assert.equal(planned.status, 0);
  const args = JSON.parse(planned.stdout) as string[];
  assert.equal(args.includes('LoamPageNotes'), true);
  assert.equal(args.includes('CODE_SIGNING_ALLOWED=NO'), true);
  assert.equal(args.at(-1), 'build');
  assert.equal(args.filter((item) => item === '-scheme').length, 1);
  assert.equal(planned.built, false);
});

function inspect(schemes: string[], projects = 1): { status: number | null; stdout: string; stderr: string; built: boolean } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-safari-plan-'));
  for (let index = 0; index < projects; index += 1) fs.mkdirSync(path.join(root, `App${index}.xcodeproj`));
  const list = path.join(root, 'list.json');
  fs.writeFileSync(list, JSON.stringify({ project: { schemes } }));
  try {
    const result = run(root, [list], { LOAM_SAFARI_INSPECT: 'plan' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, built: fs.existsSync(path.join(root, 'DerivedData')) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run(root: string, extra: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('py', ['-3', script, root, ...extra], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LOAM_SAFARI_INSPECT: '', ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
