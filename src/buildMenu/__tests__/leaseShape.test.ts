import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { PreviewLease } from '../../../packages/shared/src/buildMenu.js';

const sharedSource = fs.readFileSync(new URL('../../../packages/shared/src/buildMenu.ts', import.meta.url), 'utf8');

type HttpLease = Extract<PreviewLease, { kind: 'http' }>;
type NativeLease = Extract<PreviewLease, { kind: 'native' }>;

const httpLease = {
  kind: 'http',
  leaseId: 'lease-http',
  url: 'http://127.0.0.1:9/',
  jobId: 'job-http',
  messageNonce: 'ab'.repeat(16),
} as const satisfies HttpLease;

const nativeLease = {
  kind: 'native',
  leaseId: 'lease-native',
  jobId: 'job-native',
} as const satisfies NativeLease;

function previewLeaseBody(source: string): string {
  const start = source.indexOf('export type PreviewLease =');
  const end = source.indexOf('\nexport ', start + 1);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end).trim();
}

function unionMembers(typeSource: string): string[] {
  return typeSource
    .replace(/^export type PreviewLease =\s*/, '')
    .replace(/;\s*$/, '')
    .split('|')
    .map((member) => member.replace(/\s+/g, ' ').trim().replace(/;$/, ''))
    .filter((member) => member.length > 0);
}

function fieldNames(member: string): string[] {
  const inner = member.replace(/^\{/, '').replace(/\}$/, '').trim();
  return inner
    .split(';')
    .map((field) => field.trim())
    .filter((field) => field.length > 0)
    .map((field) => field.slice(0, field.indexOf(':')).trim());
}

test('http and native preview leases match the shared contract', () => {
  const members = unionMembers(previewLeaseBody(sharedSource));
  const http = members.find((member) => member.startsWith("{ kind: 'http'"));
  const native = members.find((member) => member.startsWith("{ kind: 'native'"));
  assert.ok(http);
  assert.ok(native);
  assert.deepEqual(fieldNames(http), ['kind', 'leaseId', 'url', 'jobId', 'messageNonce']);
  assert.deepEqual(fieldNames(native), ['kind', 'leaseId', 'jobId']);
  assert.equal(fieldNames(native).includes('pid'), false);
  assert.equal(fieldNames(native).includes('messageNonce'), false);
  assert.deepEqual(Object.keys(httpLease), ['kind', 'leaseId', 'url', 'jobId', 'messageNonce']);
  assert.deepEqual(Object.keys(nativeLease), ['kind', 'leaseId', 'jobId']);
  assert.equal('pid' in nativeLease, false);
  assert.equal('messageNonce' in nativeLease, false);
  assert.equal(httpLease.kind, 'http');
  assert.equal(nativeLease.kind, 'native');
});
