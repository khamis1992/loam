import test from 'node:test';
import assert from 'node:assert/strict';
import { starterMobile } from '../mobile/fixture.js';
import { simulationDocument } from '../mobile/simulation.js';

test('mobile simulation accepts only rtl or ltr and keeps the source-only label', () => {
  const rtl = simulationDocument(starterMobile());
  assert.match(rtl, /dir="rtl"/);
  assert.match(rtl, /ليست محاكياً أصلياً/);
  assert.match(rtl, /ليس ملف APK/);
  const ltr = simulationDocument({ ...starterMobile(), direction: 'ltr' });
  assert.match(ltr, /dir="ltr"/);
  assert.equal(ltr.includes('onload'), false);
  assert.throws(
    () => simulationDocument({ ...starterMobile(), direction: 'rtl" onload="alert(1)' as 'rtl' }),
    /unsafe_path/,
  );
});
