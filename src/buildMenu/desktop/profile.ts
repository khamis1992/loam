import type { BuildProfile } from '../../../packages/shared/src/buildMenu.js';

export const desktopProfile: BuildProfile = {
  kind: 'desktop',
  preview: 'window',
  requirements: ['node', 'electron'],
  exports: ['source-zip', 'portable-exe'],
  network: 'loopback',
  externalEffects: 'approval-required',
};

export const desktopBrief = 'أنشئ تطبيق Windows مستقلاً؛ واجهة محلية ومفاتيح اختصار وحالة فارغة وخطأ وحفظ محلي. renderer بلا Node ولا جسر Loam. لا تسجّل autostart ولا تنشر المثبت؛ الناتج portable غير موقّع موصوف بوضوح.';
