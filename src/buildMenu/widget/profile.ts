import type { BuildProfile } from '../../../packages/shared/src/buildMenu.js';

export const widgetProfile: BuildProfile = {
  kind: 'widget',
  preview: 'widget',
  requirements: ['node', 'electron'],
  exports: ['source-zip', 'portable-exe'],
  network: 'none',
  externalEffects: 'approval-required',
};

export const widgetBrief = 'أنشئ ويدجت محلياً صغيراً؛ compact/expanded وموضع محفوظ وإغلاق إلى tray وزر إنهاء صريح. التشغيل التلقائي مع الإقلاع مغلق ويتطلب اختيار المستخدم. لا طلب بيانات الإنترنت ولا صلاحيات عامة.';
