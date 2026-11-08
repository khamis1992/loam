import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJobEvidence } from '../evidence.js';
import { BuildMenuError } from '../grants.js';

const SCHEME_FIELDS = ['screenshot', 'file', 'filePath', 'file_path', 'filepath', 'path'] as const;

const REFUSED_VALUES = [
  'mailto:user@example.com',
  'tel:+97400000000',
  'sms:+97400000000?body=hi',
  'intent:#Intent;end',
  'market://details?id=com.example.app',
  'mailto%3Auser%40example.com',
  'TEL%3A%2B97400000000',
  'sms%3A%2B97400000000',
  'intent%3A%23Intent%3Bend',
  'Market%3A%2F%2Fdetails%3Fid%3Dcom.example.app',
  'mailto%253Auser%2540example.com',
  'tel%253A%252B97400000000',
  'sms%253A%252B97400000000',
  'intent%253A%2523Intent%253Bend',
  'market%253A%252F%252Fdetails',
  '%6d%61%69%6c%74%6f%3auser%40example.com',
  '%256d%2561%2569%256c%2574%256f%253auser%2540example.com',
  'MaIlTo:user@example.com',
  'Sms%253A123',
  'C:/shots/mailto:user@example.com.png',
  'C:/shots/mailto%253Auser.png',
  'https://evil.example/a.png',
  'javascript:alert(1)',
  'data:text/html,hi',
  'file:///C:/Windows/win.ini',
  'blob:null/1',
  'https%3A%2F%2Fevil.example/a.png',
];

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400;
}

test('evidence refuses mailto tel sms intent and market schemes before writing a screenshot or path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-evidence-mailto-'));
  const target = path.join(root, '.loam', 'build-menu', 'evidence', 'job_mailto', 'result.json');
  const allowed = {
    phase: 'completed',
    screenshot: 'shots/local.png',
    summary: 'لم تُفتح نافذة Chrome. http://127.0.0.1:9/',
  };
  try {
    writeJobEvidence(root, 'job_mailto', allowed);
    const before = fs.readFileSync(target);
    assert.match(before.toString('utf8'), /لم تُفتح نافذة Chrome/);
    assert.match(before.toString('utf8'), /http:\/\/127\.0\.0\.1:9\//);
    assert.match(before.toString('utf8'), /shots\/local\.png/);
    for (const field of SCHEME_FIELDS) {
      for (const value of REFUSED_VALUES) {
        assert.throws(
          () => writeJobEvidence(root, 'job_mailto', { phase: 'completed', [field]: value }),
          refused,
        );
        assert.deepEqual(fs.readFileSync(target), before);
      }
    }
    const fresh = path.join(root, '.loam', 'build-menu', 'evidence', 'job_fresh');
    assert.throws(
      () => writeJobEvidence(root, 'job_fresh', { phase: 'completed', screenshot: 'mailto:user@example.com' }),
      refused,
    );
    assert.equal(fs.existsSync(fresh), false);
    assert.deepEqual(fs.readFileSync(target), before);
    writeJobEvidence(root, 'job_mailto', allowed);
    const stored = fs.readFileSync(target, 'utf8');
    assert.match(stored, /لم تُفتح نافذة Chrome/);
    assert.match(stored, /http:\/\/127\.0\.0\.1:9\//);
    assert.match(stored, /shots\/local\.png/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evidence still throws unsafe_path when the job directory is a regular file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-evidence-mailto-file-'));
  const blocked = path.join(root, '.loam', 'build-menu', 'evidence', 'job_file');
  fs.mkdirSync(path.dirname(blocked), { recursive: true });
  fs.writeFileSync(blocked, 'not a directory');
  try {
    assert.throws(
      () => writeJobEvidence(root, 'job_file', { phase: 'completed', summary: 'لم تُفتح نافذة Chrome. http://127.0.0.1:9/' }),
      refused,
    );
    assert.equal(fs.readFileSync(blocked, 'utf8'), 'not a directory');
    assert.equal(fs.statSync(blocked).isFile(), true);
    assert.equal(fs.lstatSync(blocked).isSymbolicLink(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evidence keeps a bare hash and still redacts a grant id assignment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-evidence-mailto-hash-'));
  const hash = 'ab'.repeat(32);
  try {
    writeJobEvidence(root, 'job_hash', { phase: 'completed', summary: `${hash} grantId=${hash}` });
    const stored = fs.readFileSync(path.join(root, '.loam', 'build-menu', 'evidence', 'job_hash', 'result.json'), 'utf8');
    assert.equal(stored.includes(hash), true);
    assert.equal(stored.includes(`grantId=${hash}`), false);
    assert.match(stored, /\[redacted\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
