import type { BuildProfile } from '../../../packages/shared/src/buildMenu.js';

export const safariProfile: BuildProfile = {
  kind: 'safari-extension',
  preview: 'extension',
  requirements: ['node'],
  exports: ['source-zip', 'mv3-zip', 'xcode-source'],
  network: 'none',
  externalEffects: 'approval-required',
};

export const safariBrief = 'أنتج Web Extension متوافقة المصدر بحد صلاحيات ضيق، وبيّن أن Windows يصدر المصدر فقط. إنشاء مشروع Xcode واختبار Safari على Mac مستقل؛ لا شهادة أو حساب مدفوع يفترض لكل تطوير محلي ولا رفع متجر بلا موافقة.';
