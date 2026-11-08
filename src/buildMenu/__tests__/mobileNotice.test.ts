import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mobileNotice, refuseApkReady } from '../mobile/notice.js';

const NOTICE = 'محاكاة الويب — ليست محاكياً أصلياً. تصدير المصدر ليس ملف APK.';

test('the arabic notice says web simulation is not a native simulator and source export is not an APK', () => {
  assert.equal(mobileNotice, NOTICE);
  assert.match(mobileNotice, /ليست محاكياً أصلياً/);
  assert.match(mobileNotice, /تصدير المصدر ليس ملف APK/);
  assert.equal(refuseApkReady({ apkReady: false }), NOTICE);
});

test('a status that says apkReady true is refused and no APK is built', () => {
  assert.throws(() => refuseApkReady({ apkReady: true }), { message: 'not_an_apk' });
  const source = fs.readFileSync(path.join('src', 'buildMenu', 'mobile', 'notice.ts'), 'utf8');
  assert.equal(source.includes('gradle'), false);
  assert.equal(source.includes('assembleDebug'), false);
  assert.equal(source.includes('spawn'), false);
  assert.equal(source.includes('writeFile'), false);
});
