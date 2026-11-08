import type { BuildProfile } from '../../../packages/shared/src/buildMenu.js';

export const automationProfile: BuildProfile = {
  kind: 'automation',
  preview: 'dry-run',
  requirements: ['node'],
  exports: ['source-zip'],
  network: 'none',
  externalEffects: 'approval-required',
};

export const automationsBrief = 'حوّل النتيجة إلى جدول وخطوات مقروءة؛ Asia/Qatar افتراضي. ابدأ dry-run؛ لا تفعّل الإرسال أو النشر أو الشراء أو حذف الملفات. كل أثر خارجي ينتظر موافقة المستخدم على المستلم والنص. لا تعد بتشغيل والجهاز مغلق.';
