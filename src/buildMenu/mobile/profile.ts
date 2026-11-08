import type { BuildProfile } from '../../../packages/shared/src/buildMenu.js';

export const mobileProfile: BuildProfile = {
  kind: 'mobile',
  preview: 'device-frame',
  requirements: ['node'],
  exports: ['source-zip', 'apk-debug'],
  network: 'loopback',
  externalEffects: 'approval-required',
};

export const mobileBrief = 'استخدم MobileProject الموجود ولا تنشئ DSL جديداً. فرّق محاكاة الويب عن التطبيق الأصلي. احفظ هوية وحالة التنقل والبيانات؛ لا تدّع وجود sync أو authentication أو دفع. كل APK/IPA يحتاج بناء واختباراً مستقلاً لا مجرد ZIP.';
