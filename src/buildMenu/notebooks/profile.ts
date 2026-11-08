import type { BuildProfile } from '../../../packages/shared/src/buildMenu.js';

export const notebookProfile: BuildProfile = {
  kind: 'notebook',
  preview: 'notebook',
  requirements: ['python-container'],
  exports: ['source-zip', 'ipynb'],
  network: 'none',
  externalEffects: 'approval-required',
};

export const notebooksBrief = 'أنتج nbformat4 بخلايا قصيرة ووصف مصدر البيانات؛ لا تثبت pip داخل خلية ولا تصل الشبكة. لا تقرأ مسارات خارج البيانات المنسوخة للمشروع. التنفيذ داخل حاوية مع حدود وإلغاء؛ عند غيابها اسمح بالتحرير والتصدير فقط.';
