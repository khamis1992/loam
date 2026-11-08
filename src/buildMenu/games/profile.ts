import type { BuildProfile } from '../../../packages/shared/src/buildMenu.js';

export const gameProfile: BuildProfile = {
  kind: 'game',
  preview: 'game',
  requirements: ['node'],
  exports: ['source-zip', 'web-zip'],
  network: 'loopback',
  externalEffects: 'approval-required',
};

export const gamesBrief = 'ابنِ لعبة متصفح 2D بهدف وتحكم وفوز وخسارة وإعادة؛ استخدم رسوماً هندسية أو أصولاً محلية مرخصة. افصل tuning config عن الكود. لا تعد بأن FPS وحده جودة لعب ولا تستخدم موسيقى أو assets مجهولة الترخيص.';
