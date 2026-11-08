import assert from 'node:assert/strict';
import test from 'node:test';
import { cartTotal, demoReply, reserve } from '../websites/demo.js';

const REPLY = 'هذه محادثة تجريبية؛ لم يُرسل طلب أو يُنفذ حجز خارج هذا الجهاز.';

const USER_TEXT = [
  'mailto:user@example.com',
  'tel:+97455500000',
  'sms:+97455500000',
  'intent:#Intent;end',
  'market://details',
  'https://evil.example/a',
  'javascript:alert(1)',
] as const;

test('demoReply keeps the experimental sentence and does not echo a remote scheme', () => {
  for (const text of USER_TEXT) {
    const reply = demoReply(`احجز ${text}`);
    assert.equal(reply, REPLY, text);
    const scheme = text.slice(0, text.indexOf(':'));
    assert.equal(reply.toLowerCase().includes(scheme), false, text);
    assert.equal(reply.includes(text), false, text);
  }
});

test('cartTotal of the store prices that sum to 3700 stays 3700', () => {
  assert.equal(cartTotal([2500, 1200]), 3700);
});

test('reserve throws slot_taken for a duplicate slot', () => {
  assert.throws(() => reserve(['2026-11-10T09:00'], '2026-11-10T09:00'), /slot_taken/);
});
