import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { websiteProfile, websitesBrief } from '../websites/profile.js';
import { cartTotal, demoReply, reserve } from '../websites/demo.js';
import { websiteDocument } from '../websites/page.js';

test('website: fixed capability boundary', () => {
  assert.equal(websiteProfile.kind, 'website');
  assert.equal(websiteProfile.preview, 'web');
  assert.equal(websiteProfile.externalEffects, 'approval-required');
  assert.ok(websiteProfile.exports.includes('source-zip'));
  assert.ok(websitesBrief.length > 40);
});

test('demo booking prevents same local slot twice', () => {
  assert.deepEqual(reserve([], '2026-11-10T09:00'), ['2026-11-10T09:00']);
  assert.throws(() => reserve(['slot-1'], 'slot-1'), /slot_taken/);
});

test('cart uses integer minor units; chatbot cannot claim external action', () => {
  assert.equal(cartTotal([2500, 1200]), 3700);
  assert.throws(() => cartTotal([-1]), /invalid_price/);
  assert.match(demoReply('احجز الآن'), /تجريبية/);
});

test('the four website pages stay local', () => {
  const store = websiteDocument('متجر', 'store');
  assert.match(store, /دفتر/);
  assert.match(store, /قلم/);
  assert.match(store, /حقيبة/);
  assert.match(store, />8200</);
  const landing = websiteDocument('<script>', 'landing');
  assert.equal(landing.includes('<script>'), true);
  assert.equal(landing.includes('<h1><script>'), false);
  assert.match(landing, /preventDefault/);
  assert.doesNotMatch(landing, /action=/);
  const booking = websiteDocument('حجز', 'booking');
  assert.match(booking, /Asia\/Qatar/);
  assert.equal(runClicks(booking, '2026-11-10T09:00', 2).out, 'slot_taken');
  const chat = websiteDocument('دردشة', 'chatbot');
  assert.equal(runChat(chat, 'احجز الآن').out, demoReply('احجز الآن'));
  for (const html of [store, landing, booking, chat]) assert.doesNotMatch(html, /https?:\/\//);
});

test('a landing request stays on this device and a broken request starts empty', () => {
  const html = websiteDocument('هبوط', 'landing');
  const sent = runLead(html, 'خميس');
  assert.equal(sent.out, 'بقيت الرسالة على هذا الجهاز');
  assert.equal(sent.lead.hidden, false);
  assert.equal(sent.storage.get('loam-lead'), '"خميس"');
  const reopened = runLead(html, '', { saved: '"خميس"', submit: false });
  assert.equal(reopened.input, 'خميس');
  assert.equal(reopened.lead.hidden, false);
  const broken = runLead(html, '', { saved: '{bad', submit: false });
  assert.equal(broken.out, 'تعذرت قراءة الطلب المحفوظ؛ بدأ النموذج فارغاً');
  assert.equal(broken.input, '');
  assert.equal(broken.lead.hidden, true);
  assert.equal(broken.storage.has('loam-lead'), false);
  const moved = runLead(html, 'خميس');
  moved.exportButton.onclick();
  assert.equal(moved.state.value, '"خميس"');
  moved.state.value = '"ليلى"';
  moved.importButton.onclick();
  assert.equal(moved.field.value, 'ليلى');
  assert.equal(moved.lead.hidden, false);
  assert.equal(moved.storage.get('loam-lead'), '"ليلى"');
  moved.state.value = '{bad';
  moved.importButton.onclick();
  assert.equal(moved.liveOut.textContent, 'تعذرت قراءة الطلب المحفوظ؛ بدأ النموذج فارغاً');
  assert.equal(moved.field.value, '');
  assert.equal(moved.storage.has('loam-lead'), false);
  assert.doesNotMatch(html, /action=|fetch\(/);
});

test('a booking stays on this device and a broken list starts empty', () => {
  const html = websiteDocument('حجز', 'booking');
  const first = runClicks(html, '2026-11-10T09:00', 1);
  assert.equal(first.out, 'تم الحفظ محلياً');
  const saved = first.storage.get('loam-booking');
  assert.equal(saved, '["2026-11-10T09:00"]');
  const again = runClicks(html, '2026-11-10T09:00', 1, saved);
  assert.equal(again.out, 'slot_taken');
  const broken = runClicks(html, '2026-11-10T10:00', 0, '{bad');
  assert.equal(broken.out, 'تعذرت قراءة الحجوزات المحفوظة؛ بدأت قائمة فارغة');
  assert.equal(broken.storage.get('loam-booking'), '[]');
  const duplicate = runClicks(html, '2026-11-10T10:00', 0, '["2026-11-10T09:00","2026-11-10T09:00"]');
  assert.equal(duplicate.out, 'تعذرت قراءة الحجوزات المحفوظة؛ بدأت قائمة فارغة');
  assert.equal(duplicate.storage.get('loam-booking'), '[]');
  const flooded = runClicks(html, '2026-11-10T10:00', 0, JSON.stringify(Array.from({ length: 4 }, () => '2026-11-10T09:00')));
  assert.equal(flooded.storage.get('loam-booking'), '[]');
  const kept = runClicks(html, '2026-11-10T09:00', 1, '["2026-11-10T11:00","2026-11-10T09:00","2026-11-10T10:00"]');
  assert.equal(kept.out, 'slot_taken');
  assert.equal(JSON.parse(kept.storage.get('loam-booking') ?? '[]').length, 3);
  kept.exportButton.onclick();
  assert.equal(kept.state.value, kept.storage.get('loam-booking'));
  kept.state.value = '["2026-11-10T10:00"]';
  kept.importButton.onclick();
  assert.equal(kept.storage.get('loam-booking'), '["2026-11-10T10:00"]');
  assert.equal(kept.liveOut.textContent, '');
  kept.state.value = '{bad';
  kept.importButton.onclick();
  assert.equal(kept.liveOut.textContent, 'تعذرت قراءة الحجوزات المحفوظة؛ بدأت قائمة فارغة');
  assert.equal(kept.storage.get('loam-booking'), '[]');
  const foreign = runClicks(html, 'https://evil.example/slot', 1);
  assert.equal(foreign.out, 'invalid_slot');
  assert.equal(foreign.storage.get('loam-booking'), '[]');
  assert.equal(JSON.stringify([...foreign.storage.values()]).includes('evil.example'), false);
});

test('a chatbot log stays on this device and a broken log starts empty', () => {
  const html = websiteDocument('دردشة', 'chatbot');
  const broken = runChat(html, 'مرحبا', { saved: '{bad', submit: false });
  assert.equal(broken.out, 'تعذرت قراءة المحادثة المحفوظة؛ بدأت محادثة فارغة');
  assert.equal(broken.log, '');
  assert.equal(broken.storage.get('loam-chat'), '[]');

  const sent = runChat(html, 'احجز الآن');
  assert.equal(sent.out, demoReply('احجز الآن'));
  assert.match(sent.log, /احجز الآن/);
  assert.match(sent.log, /تجريبية/);
  const saved = sent.storage.get('loam-chat');
  assert.equal(typeof saved, 'string');

  const reopened = runChat(html, '', { saved, submit: false });
  assert.match(reopened.log, /احجز الآن/);
  assert.equal(reopened.out, '');
  const lines = Array.from({ length: 40 }, (_item, index) => `سطر ${index}`);
  const full = runChat(html, 'جديد', { saved: JSON.stringify(lines) });
  const stored = JSON.parse(full.storage.get('loam-chat') ?? '[]') as string[];
  assert.equal(stored.length, 40);
  assert.equal(stored.at(-2), 'جديد');
  assert.match(stored.at(-1) ?? '', /تجريبية/);
  assert.equal(stored.includes('سطر 0'), false);
  const kept = runChat(html, '', { saved: full.storage.get('loam-chat'), submit: false });
  assert.match(kept.log, /جديد/);
  assert.equal(kept.out, '');
  const huge = JSON.stringify(Array.from({ length: 41 }, () => 'زائد'));
  const rejected = runChat(html, '', { saved: huge, submit: false });
  assert.equal(rejected.out, 'تعذرت قراءة المحادثة المحفوظة؛ بدأت محادثة فارغة');
  assert.equal(rejected.storage.get('loam-chat'), '[]');
  assert.doesNotMatch(html, /fetch\(|innerHTML/);
});

test('a store cart adds two local prices and recovers a broken saved cart', () => {
  const html = websiteDocument('متجر', 'store');
  assert.match(html, /صدّر الحالة/);
  assert.match(html, /استورد الحالة/);
  assert.doesNotMatch(html, /fetch\(|require\(|process\.|fs\./);
  const broken = runStore(html, { saved: '{bad' });
  assert.equal(broken.out.textContent, 'تعذرت قراءة السلة المحفوظة؛ بدأت سلة فارغة');
  assert.equal(broken.total.textContent, '0');
  assert.equal(broken.storage.get('loam-store'), '[]');

  const cart = runStore(html, {});
  cart.buttons[0]!.onclick();
  cart.buttons[1]!.onclick();
  assert.equal(cart.total.textContent, '3700');
  cart.exportButton.onclick();
  assert.equal(cart.state.value, '["دفتر","قلم"]');

  const imported = runStore(html, { state: '["دفتر","قلم"]' });
  imported.importButton.onclick();
  assert.equal(imported.total.textContent, '3700');
  assert.equal(imported.out.textContent, '');

  const rejected = runStore(html, { state: '{bad' });
  rejected.importButton.onclick();
  assert.equal(rejected.total.textContent, '0');
  assert.equal(rejected.out.textContent, 'تعذرت قراءة السلة المحفوظة؛ بدأت سلة فارغة');

  const full = runStore(html, { state: JSON.stringify(Array.from({ length: 1000 }, () => 'دفتر')) });
  full.importButton.onclick();
  assert.equal(full.total.textContent, '2500000');
  const oversized = runStore(html, { state: JSON.stringify(Array.from({ length: 1001 }, () => 'دفتر')) });
  oversized.importButton.onclick();
  assert.equal(oversized.total.textContent, '0');
  assert.equal(oversized.out.textContent, 'تعذرت قراءة السلة المحفوظة؛ بدأت سلة فارغة');
  assert.equal(oversized.storage.get('loam-store'), '[]');

  const foreign = runStore(html, { extraSku: 'https://evil.example/sku' });
  foreign.buttons[0]?.onclick();
  assert.equal(foreign.total.textContent, '2500');
  foreign.buttons[3]?.onclick();
  assert.equal(foreign.out.textContent, 'هذا المنتج ليس في المتجر المحلي');
  assert.equal(foreign.total.textContent, '2500');
  assert.equal(foreign.storage.get('loam-store'), '["دفتر"]');
  assert.equal(JSON.stringify([...foreign.storage.values()]).includes('evil.example'), false);
});

function runLead(html: string, name: string, input: { saved?: string; submit?: boolean } = {}): {
  out: string;
  input: string;
  lead: { hidden: boolean };
  field: { value: string };
  liveOut: { textContent: string };
  state: { value: string };
  exportButton: { onclick: () => void };
  importButton: { onclick: () => void };
  storage: Map<string, string>;
} {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
  const storage = new Map<string, string>();
  if (input.saved !== undefined) storage.set('loam-lead', input.saved);
  const out = { textContent: '' };
  const lead = { hidden: true };
  const field = { value: name };
  const state = { value: '' };
  const exportButton = { onclick: () => undefined };
  const importButton = { onclick: () => undefined };
  let submit = (_event?: { preventDefault: () => void }) => undefined;
  Object.defineProperty(lead, 'onsubmit', { set(value: typeof submit) { submit = value; } });
  const document = {
    getElementById(id: string) {
      if (id === 'out') return out;
      if (id === 'lead') return lead;
      if (id === 'state') return state;
      if (id === 'export') return exportButton;
      if (id === 'import') return importButton;
      return { onclick: () => undefined };
    },
    querySelector() { return field; },
  };
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  vm.runInContext(script, vm.createContext({ document, localStorage, JSON }));
  if (input.submit !== false) submit({ preventDefault() { return undefined; } });
  return { out: out.textContent, input: field.value, lead, field, liveOut: out, state, exportButton, importButton, storage };
}

function runClicks(html: string, slot: string, times: number, saved?: string): {
  out: string;
  liveOut: { textContent: string };
  state: { value: string };
  exportButton: { onclick: () => void };
  importButton: { onclick: () => void };
  storage: Map<string, string>;
} {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
  const storage = new Map<string, string>();
  if (saved !== undefined) storage.set('loam-booking', saved);
  const out = { textContent: '' };
  const state = { value: '' };
  const exportButton = { onclick: () => undefined };
  const importButton = { onclick: () => undefined };
  const buttons = [{ getAttribute: () => slot, onclick: (_event?: unknown) => undefined }];
  const document = {
    getElementById(id: string) {
      if (id === 'state') return state;
      if (id === 'export') return exportButton;
      if (id === 'import') return importButton;
      return out;
    },
    querySelectorAll: () => buttons,
  };
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  };
  vm.runInContext(script, vm.createContext({ document, localStorage, JSON }));
  const button = buttons[0];
  if (!button) throw new Error('missing button');
  for (let i = 0; i < times; i += 1) button.onclick();
  return { out: out.textContent, liveOut: out, state, exportButton, importButton, storage };
}

function runStore(html: string, input: { saved?: string; state?: string; extraSku?: string }): {
  total: { textContent: string };
  out: { textContent: string };
  state: { value: string };
  buttons: Array<{ onclick: () => void }>;
  exportButton: { onclick: () => void };
  importButton: { onclick: () => void };
  storage: Map<string, string>;
} {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
  const storage = new Map<string, string>();
  if (input.saved !== undefined) storage.set('loam-store', input.saved);
  const total = { textContent: '' };
  const out = { textContent: '' };
  const state = { value: input.state ?? '' };
  const skus = input.extraSku === undefined ? ['دفتر', 'قلم', 'حقيبة'] : ['دفتر', 'قلم', 'حقيبة', input.extraSku];
  const buttons = skus.map((sku) => ({ getAttribute: () => sku, onclick: () => undefined }));
  const exportButton = { onclick: () => undefined };
  const importButton = { onclick: () => undefined };
  const document = {
    getElementById(id: string) {
      if (id === 'total') return total;
      if (id === 'out') return out;
      if (id === 'state') return state;
      if (id === 'export') return exportButton;
      if (id === 'import') return importButton;
      return undefined;
    },
    querySelectorAll: () => buttons,
  };
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  };
  vm.runInContext(script, vm.createContext({ document, localStorage, JSON, Object, Number }));
  return { total, out, state, buttons, exportButton, importButton, storage };
}

function runChat(html: string, message: string, input: { saved?: string; submit?: boolean } = {}): {
  out: string;
  log: string;
  storage: Map<string, string>;
} {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
  const storage = new Map<string, string>();
  if (input.saved !== undefined) storage.set('loam-chat', input.saved);
  const out = { textContent: '' };
  const log = { textContent: '' };
  const state = { value: '' };
  const exportButton = { onclick: () => undefined };
  const importButton = { onclick: () => undefined };
  let submit = (_event?: { preventDefault: () => void }) => undefined;
  const document = {
    getElementById(id: string) {
      switch (id) {
        case 'out': return out;
        case 'log': return log;
        case 'state': return state;
        case 'export': return exportButton;
        case 'import': return importButton;
        default: return undefined;
      }
    },
    querySelector(selector: string) {
      if (selector === 'form') return { set onsubmit(value: typeof submit) { submit = value; } };
      return { value: message };
    },
  };
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  };
  vm.runInContext(script, vm.createContext({ document, localStorage, JSON }));
  if (input.submit !== false) submit({ preventDefault() { return undefined; } });
  return { out: out.textContent, log: log.textContent, storage };
}
