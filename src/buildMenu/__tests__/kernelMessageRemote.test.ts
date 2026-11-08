import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildMenuError } from '../grants.js';
import { KERNEL_TIMEOUT_MS, parseKernelStdout } from '../notebooks/messages.js';

const SCHEMES: ReadonlyArray<readonly [string, string]> = [
  ['mailto', 'user@example.test'],
  ['tel', '+97400000000'],
  ['sms', '+97400000000'],
  ['intent', '#Intent;end'],
  ['market', '//details?id=app'],
  ['https', '//example.test/a'],
  ['javascript', 'alert(1)'],
  ['data', 'text/html,hi'],
  ['file', '///c:/secret'],
  ['blob', 'null/uuid'],
];

const ONCE_ENCODED = [
  'mailto%3Auser@example.test',
  'mail%74o:user@example.test',
  'mailto%20:user@example.test',
  'https%3A%2F%2Fexample.test/a',
  'javascript%3Aalert(1)',
  'tel%3A%2B97400000000',
  'sms%3A%2B97400000000',
  'intent%3A%23Intent;end',
  'market%3A%2F%2Fdetails?id=app',
  'data%3Atext/html,hi',
  'file%3A%2F%2F%2Fc%3A%2Fsecret',
  'blob%3Anull/uuid',
  '%6d%61%69%6c%74%6f%3Auser@example.test',
  '%6D%61%69%6C%74%6F%3Auser@example.test',
];

function refused(error: unknown): boolean {
  return error instanceof BuildMenuError && (error.message === 'unsafe_path' || error.message === 'tool_failed');
}

function output(messageType: string, content: unknown): string {
  return JSON.stringify({ type: 'output', cellId: 'cell-1', messageType, content });
}

function percentEncode(value: string): string {
  return Array.from(value, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
}

function assertRefused(raw: string, label: string): void {
  assert.throws(() => {
    const parsed = parseKernelStdout(raw, 'cell-1');
    assert.equal(JSON.stringify(parsed).includes(label), false);
  }, refused, label);
}

function splitName(name: string): [string, string] {
  const mid = Math.max(1, Math.floor(name.length / 2));
  return [name.slice(0, mid), name.slice(mid)];
}

test('a normal print line still parses', () => {
  assert.equal(KERNEL_TIMEOUT_MS, 30_000);
  const raw = [
    JSON.stringify({ type: 'status', cellId: 'cell-1', messageType: 'status', content: { execution_state: 'busy' } }),
    output('stream', { name: 'stdout', text: '3\n' }),
    JSON.stringify({ type: 'complete', cellId: 'cell-1' }),
  ].join('\n');
  const parsed = parseKernelStdout(raw, 'cell-1');
  assert.equal(parsed.text, '3\n');
  assert.deepEqual(parsed.outputs, [{ output_type: 'stream', name: 'stdout', text: ['3\n'] }]);
  const noted = parseKernelStdout(output('stream', { text: 'total: 3\n' }), 'cell-1');
  assert.equal(noted.text, 'total: 3\n');
  assert.deepEqual(noted.outputs, [{ output_type: 'stream', name: 'stdout', text: ['total: 3\n'] }]);
});

test('stream and output text refuse remote schemes, including one percent-decode', () => {
  for (const [name, rest] of SCHEMES) {
    const text = `${name}:${rest}`;
    const samples = [text, text.toUpperCase(), `${name} :${rest}`, `${name}%3A${rest}`, percentEncode(text)];
    for (const sample of samples) {
      assertRefused(output('stream', { name: 'stdout', text: sample }), sample);
      assertRefused(output('stream', { text: [sample] }), sample);
      assertRefused(output('display_data', { data: { 'text/plain': sample }, metadata: {} }), sample);
      assertRefused(output('execute_result', { data: { 'text/plain': sample }, metadata: {}, execution_count: 1 }), sample);
    }
  }
  for (const sample of ONCE_ENCODED) {
    assertRefused(output('stream', { text: sample }), sample);
    assertRefused(output('display_data', { data: { 'text/plain': sample } }), sample);
    assertRefused(output('execute_result', { data: { 'text/plain': sample }, execution_count: 1 }), sample);
  }
  assertRefused(JSON.stringify({ type: 'error', cellId: 'cell-1', error: 'mailto:user@example.test' }), 'mailto:user@example.test');
  assertRefused(output('error', { ename: 'Error', evalue: 'javascript:alert(1)', traceback: ['Traceback'] }), 'javascript:alert(1)');
});

test('a scheme split across a line is refused and not stored', () => {
  for (const [name, rest] of SCHEMES) {
    const [head, tailName] = splitName(name);
    const tail = `${tailName}:${rest}`;
    const joined = `${head}${tail}`;
    assertRefused([
      output('stream', { text: head }),
      output('stream', { text: tail }),
    ].join('\n'), joined);
    assertRefused([
      output('stream', { text: head }),
      output('stream', { text: tail }),
    ].join('\r\n'), joined);
    assertRefused(output('stream', { text: `${head}\n${tail}` }), joined);
    assertRefused(output('stream', { text: [head, `\n${tail}`] }), joined);
    assertRefused(output('display_data', { data: { 'text/plain': `${head}\n${tail}` } }), joined);
    assertRefused(output('execute_result', { data: { 'text/plain': [head, tail] }, execution_count: 1 }), joined);
    assertRefused([
      output('stream', { text: `${head}\n` }),
      output('display_data', { data: { 'text/plain': tail } }),
    ].join('\n'), joined);
  }
  assertRefused([
    output('stream', { text: 'mail%74' }),
    output('stream', { text: 'o:user@example.test' }),
  ].join('\n'), 'mailto:user@example.test');
  assertRefused(output('stream', { text: 'java\nscript%3Aalert(1)' }), 'javascript:alert(1)');
  assertRefused(output('display_data', { data: { 'text/plain': 'mail%0Ato:user@example.test' } }), 'mailto:user@example.test');
  assertRefused([
    output('stream', { text: 'https%3A%2F' }),
    output('execute_result', { data: { 'text/plain': '%2Fexample.test/a' }, execution_count: 1 }),
  ].join('\n'), 'https://example.test/a');
});
