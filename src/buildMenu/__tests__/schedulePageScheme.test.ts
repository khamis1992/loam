import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleCard, schedulePage, upcomingRuns } from '../automations/schedule.js';

const SCHEMES = ['mailto', 'tel', 'sms', 'intent', 'market'] as const;
const SEND_BLOCK = '<p id="send-block">الإرسال متوقف حتى موافقة منفصلة. لم تُرسل رسالة.</p>';

function refused(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function encodeChars(value: string): string {
  return [...value].map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
}

test('a normal local card still renders at 09:00 Asia/Qatar and نشر is left alone', () => {
  const runs = upcomingRuns('0 9 * * *', new Date('2026-11-05T05:00:00.000Z'));
  assert.equal(runs.length, 3);
  for (const run of runs) assert.equal(run.getUTCHours(), 6);
  assert.equal(runs[0]?.toISOString(), '2026-11-05T06:00:00.000Z');
  const card = scheduleCard(runs);
  assert.match(card, /متى: 09:00 Asia\/Qatar/);
  const page = schedulePage(`${card}\nhotel: downtown\nsupermarket: open\nnote 100% done\nنشر`);
  assert.match(page, /<!doctype html>/);
  assert.match(page, /09:00 Asia\/Qatar/);
  assert.match(page, /hotel: downtown/);
  assert.match(page, /supermarket: open/);
  assert.match(page, /note 100% done/);
  assert.match(page, /نشر/);
  assert.equal(page.includes('<script'), false);
  assert.equal(page.includes('send-block'), false);
  const brief = schedulePage(card, false, 'hotel: downtown and supermarket: open نشر');
  assert.match(brief, /<pre id="brief">hotel: downtown and supermarket: open نشر<\/pre>/);
  assert.match(schedulePage(card, false, 'note 100% done'), /note 100% done/);
  const scripted = schedulePage(`${card}<script>alert(1)</script>`);
  assert.equal(scripted.includes('<script'), false);
  assert.match(scripted, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('the send-blocked sentence still says nothing was sent', () => {
  const card = scheduleCard(upcomingRuns('0 9 * * 1', new Date('2026-11-06T12:00:00.000Z')));
  const blocked = schedulePage(card, true, 'ملخص محلي');
  assert.match(blocked, /09:00 Asia\/Qatar/);
  assert.match(blocked, /ملخص محلي/);
  assert.ok(blocked.includes(SEND_BLOCK));
  assert.match(blocked, /لم تُرسل رسالة/);
});

test('schedulePage rejects https and script tags', () => {
  const card = scheduleCard(upcomingRuns('0 9 * * *', new Date('2026-11-05T05:00:00.000Z')));
  assert.throws(() => schedulePage(`${card}\nhttps://example.test`), refused);
  assert.throws(() => schedulePage('HTTP://example.test/a'), refused);
  assert.throws(() => schedulePage('see http://example.test'), refused);
  const scripted = schedulePage('<script>alert(1)</script>');
  assert.equal(scripted.includes('<script'), false);
  assert.match(scripted, /&lt;script&gt;/);
});

test('schedulePage rejects mailto, tel, sms, intent, and market, including percent-encoding once or twice', () => {
  const card = scheduleCard(upcomingRuns('0 9 * * *', new Date('2026-11-05T05:00:00.000Z')));
  const attacks = [
    'mailto:user@example.com',
    'MaIlTo:user@example.com',
    'MAILTO:user@example.com',
    'tel:+97400000000',
    'TEL:+97400000000',
    'sms:+97400000000?body=hi',
    'intent:#Intent;end',
    'market://details?id=com.example.app',
    'افتح mailto:a@b.c',
    'mailto :user@example.com',
    'mailto\t:user@example.com',
  ];
  for (const scheme of SCHEMES) {
    const literal = `${scheme}:user@example.test`;
    attacks.push(
      literal,
      `${scheme.toUpperCase()}:user@example.test`,
      `${scheme} :user@example.test`,
      `${scheme}%3auser@example.test`,
      `${scheme}%3Auser@example.test`,
      `${scheme.toUpperCase()}%3Auser@example.test`,
      `${scheme}%253auser@example.test`,
      `${scheme}%253Auser@example.test`,
      encodeChars(literal),
      encodeChars(literal).toUpperCase(),
      encodeChars(encodeChars(literal)),
      `note ${encodeChars(`${scheme}:`)} end`,
      `note ${encodeChars(encodeChars(`${scheme}:`))} end`,
    );
  }
  for (const attack of attacks) {
    assert.throws(() => schedulePage(`${card}\n${attack}`), refused, attack);
    assert.throws(() => schedulePage(attack), refused, attack);
  }
  const stayed = schedulePage(`${card}\nhotel%3A downtown\nsupermarket%3A open\nnote 100%3A done`);
  assert.match(stayed, /hotel%3A downtown/);
  assert.match(stayed, /supermarket%3A open/);
  assert.equal(/(?:mailto|tel|sms|intent|market)\s*:/i.test(stayed), false);
});
