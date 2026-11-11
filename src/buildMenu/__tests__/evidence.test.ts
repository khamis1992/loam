import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJobEvidence } from '../evidence.js';
import { BuildMenuError } from '../grants.js';

test('job evidence keeps the outcome and drops a credential', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-evidence-'));
  try {
    writeJobEvidence(root, 'job_redact', { phase: 'completed', summary: 'api_key=sk-testsecretvalue' });
    const text = fs.readFileSync(path.join(root, '.loam', 'build-menu', 'evidence', 'job_redact', 'result.json'), 'utf8');
    assert.equal(text.includes('sk-testsecretvalue'), false);
    assert.match(text, /\[redacted\]/);
    const folder = path.join(root, 'loam-secret-folder');
    writeJobEvidence(root, 'job_path', { phase: 'completed', summary: `لم تُفتح نافذة Chrome. المجلد: ${folder} http://127.0.0.1:9/` });
    const stored = fs.readFileSync(path.join(root, '.loam', 'build-menu', 'evidence', 'job_path', 'result.json'), 'utf8');
    assert.match(stored, /لم تُفتح نافذة Chrome/);
    assert.match(stored, /\[path\]/);
    assert.match(stored, /http:\/\/127\.0\.0\.1:9\//);
    assert.equal(stored.includes('loam-secret-folder'), false);
    assert.throws(
      () => writeJobEvidence(root, '../job_escape', { phase: 'completed', summary: 'x' }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evidence refuses a path that is not a directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-evidence-link-'));
  const blocked = path.join(root, '.loam', 'build-menu', 'evidence', 'job_link');
  fs.mkdirSync(path.dirname(blocked), { recursive: true });
  fs.writeFileSync(blocked, 'not a directory');
  try {
    assert.throws(
      () => writeJobEvidence(root, 'job_link', { phase: 'completed', summary: 'x' }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.readFileSync(blocked, 'utf8'), 'not a directory');
    assert.equal(fs.statSync(blocked).isFile(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evidence keeps a bare hash and redacts a grant id assignment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-evidence-hash-'));
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

test('evidence refuses a screenshot or file path that contains a remote scheme', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-evidence-scheme-'));
  const evidenceRoot = path.join(root, '.loam');
  const target = path.join(evidenceRoot, 'build-menu', 'evidence', 'job_scheme', 'result.json');
  try {
    assert.throws(
      () => writeJobEvidence(root, 'job_scheme', { phase: 'completed', screenshot: 'https://evil.example/a.png' }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.existsSync(evidenceRoot), false);
    writeJobEvidence(root, 'job_scheme', { phase: 'completed', screenshot: 'shots/local.png', summary: 'kept' });
    const before = fs.readFileSync(target);
    const records: Array<Record<string, string>> = [
      { screenshot: 'http://evil.example/a.png' },
      { screenshot: 'https://evil.example/shot.png' },
      { file: 'javascript:alert(1)' },
      { filePath: 'C:/shots/javascript:alert(1).png' },
      { path: 'javascript:alert(1)' },
      { screenshot: 'data:image/png;base64,aaaa' },
      { file: 'file:///C:/Windows/system.ini' },
      { path: 'blob:null/8c0c0c0c-0000-4000-8000-000000000000' },
      { filePath: 'https%3A%2F%2Fevil.example%2Fa.png' },
      { file_path: 'javascript%3Aalert(1)' },
      { filepath: 'http%3A%2F%2Fevil.example%2Fa.png' },
      { screenshot: 'DATA:text/html,hi' },
      { path: 'File:///C:/Windows/win.ini' },
      { file: 'BLOB:abc' },
      { screenshot: 'JavaScript%3Aalert(1)' },
    ];
    for (const record of records) {
      assert.throws(
        () => writeJobEvidence(root, 'job_scheme', { phase: 'completed', ...record }),
        (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
      );
      assert.deepEqual(fs.readFileSync(target), before);
    }
    assert.match(before.toString('utf8'), /shots\/local\.png/);
    writeJobEvidence(root, 'job_scheme', {
      phase: 'completed',
      screenshot: 'shots/local.png',
      summary: 'data: file: blob: https%3A javascript%3A stay outside path fields',
    });
    const summary = fs.readFileSync(target, 'utf8');
    assert.match(summary, /shots\/local\.png/);
    assert.match(summary, /data: file: blob: https%3A javascript%3A stay outside path fields/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evidence refuses a result path that is a directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-evidence-result-dir-'));
  const blocked = path.join(root, '.loam', 'build-menu', 'evidence', 'job_result', 'result.json');
  fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(path.join(blocked, 'keep.txt'), 'untouched');
  try {
    assert.throws(
      () => writeJobEvidence(root, 'job_result', { phase: 'completed', summary: 'x' }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsafe_path' && error.status === 400,
    );
    assert.equal(fs.statSync(blocked).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(blocked, 'keep.txt'), 'utf8'), 'untouched');
    assert.deepEqual(fs.readdirSync(blocked), ['keep.txt']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
