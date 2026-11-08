import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildMenuError } from '../grants.js';
import { kernelCommand } from '../notebooks/kernel.js';

const image = `loam-notebook@sha256:${'b'.repeat(64)}`;

test('kernel volume paths stay inside the project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kernel-mount-'));
  const outside = path.join(root, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  fs.mkdirSync(path.join(root, 'app', 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app', 'output'));
  try {
    const command = kernelCommand({
      executable: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
      image,
      workspace: root,
      projectId: 'app_abcdefghijkl',
      jobId: 'job_mount',
      nonce: '0123456789abcdef',
    });
    const volumes = command.args.filter((_arg, index, args) => args[index - 1] === '-v');
    assert.deepEqual(volumes, [
      `${path.resolve(root, 'app', 'data')}:/data:ro`,
      `${path.resolve(root, 'app', 'output')}:/output:rw`,
    ]);
    assert.equal(volumes.join('\n').includes('secret.txt'), false);
    assert.equal(command.args.includes('--network'), true);
    assert.equal(command.args[command.args.indexOf('--network') + 1], 'none');
    fs.rmSync(path.join(root, 'app', 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'data'), 'not-a-directory');
    assert.throws(
      () => kernelCommand({
        executable: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
        image,
        workspace: root,
        projectId: 'app_abcdefghijkl',
        jobId: 'job_mount',
        nonce: '0123456789abcdef',
      }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
