import type { BuildProfile } from '../../../packages/shared/src/buildMenu.js';

export const websiteProfile: BuildProfile = {
  kind: 'website',
  preview: 'web',
  requirements: ['node'],
  exports: ['source-zip', 'web-zip'],
  network: 'loopback',
  externalEffects: 'approval-required',
};

export const websitesBrief = 'ابنِ صفحات RTL قابلة للوصول؛ يحدد subtype واجهة هبوط أو متجر تجريبي أو حجز محلي أو محادثة تجريبية. لا تصف الدفع أو الحجز الحقيقي بأنه تم. لا تضع مفاتيح في frontend. اكتب معايير قبول ثم انتظر أمر بناء منفصل.';
