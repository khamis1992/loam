import type { BuildProfile } from '../../../packages/shared/src/buildMenu.js';

export const chromeProfile: BuildProfile = {
  kind: 'chrome-extension',
  preview: 'extension',
  requirements: ['node', 'chromium'],
  exports: ['source-zip', 'mv3-zip'],
  network: 'none',
  externalEffects: 'approval-required',
};

export const chromeBrief = 'أنشئ Manifest V3 بأقل صلاحيات؛ popup وservice worker عند الحاجة فقط. لا all_urls ولا cookies ولا debugger افتراضياً. فسّر كل permission، لا تمس profile المتصفح الحقيقي، وصدّر ZIP دون نشر المتجر.';
