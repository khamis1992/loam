import { getLocale, type Locale } from '@/i18n/t';

const AGENT_LABELS = {
  blankAgent: {
    en: 'Blank / Custom agent',
    ar: 'وكيل فارغ / مخصص',
  },
  blankAgentDescription: {
    en: 'Build your own agent from scratch',
    ar: 'ابنِ وكيلك الخاص من الصفر',
  },
  avatar: {
    en: 'Avatar / Emoji',
    ar: 'الصورة الرمزية / الإيموجي',
  },
  description: {
    en: 'Description',
    ar: 'الوصف',
  },
  instructions: {
    en: 'System instructions',
    ar: 'تعليمات النظام',
  },
  loamMode: {
    en: 'Loam mode',
    ar: 'وضع Loam',
  },
  model: {
    en: 'Model',
    ar: 'النموذج',
  },
  defaultModel: {
    en: 'Default (app model)',
    ar: 'افتراضي (نموذج التطبيق)',
  },
  customModel: {
    en: 'Custom model',
    ar: 'نموذج مخصص',
  },
  customModelPlaceholder: {
    en: 'Enter model name',
    ar: 'أدخل اسم النموذج',
  },
  capabilities: {
    en: 'Capabilities',
    ar: 'القدرات',
  },
  services: {
    en: 'Services',
    ar: 'الخدمات',
  },
  skills: {
    en: 'Skills',
    ar: 'المهارات',
  },
  connectors: {
    en: 'Connectors',
    ar: 'الموصلات',
  },
  memory: {
    en: 'Memory',
    ar: 'الذاكرة',
  },
  memoryOn: {
    en: 'Memory enabled (Loam execution)',
    ar: 'الذاكرة مفعّلة (تنفيذ داخل Loam)',
  },
  memoryOff: {
    en: 'Memory disabled (Chat only)',
    ar: 'الذاكرة معطّلة (دردشة فقط)',
  },
  allServices: {
    en: 'All services',
    ar: 'كل الخدمات',
  },
  createFromTemplate: {
    en: 'Create agent',
    ar: 'إنشاء وكيل',
  },
  newAgent: {
    en: 'New agent',
    ar: 'وكيل جديد',
  },
  noTemplates: {
    en: 'No templates available',
    ar: 'لا توجد قوالب متاحة',
  },
  stepTemplate: {
    en: '1. Choose a starter',
    ar: '١. اختر بداية',
  },
  stepDetails: {
    en: '2. Configure agent',
    ar: '٢. اضبط الوكيل',
  },
  editAgent: {
    en: 'Edit agent',
    ar: 'تعديل الوكيل',
  },
  effort: {
    en: 'Effort',
    ar: 'الجهد',
  },
  allowedServices: {
    en: 'Allowed services',
    ar: 'الخدمات المسموحة',
  },
  workMode: {
    en: 'Work mode',
    ar: 'وضع العمل',
  },
  cancel: {
    en: 'Cancel',
    ar: 'إلغاء',
  },
  create: {
    en: 'Create',
    ar: 'إنشاء',
  },
  save: {
    en: 'Save',
    ar: 'حفظ',
  },
  namePlaceholder: {
    en: 'Agent name',
    ar: 'اسم الوكيل',
  },
  descriptionPlaceholder: {
    en: 'Short description of what this agent does',
    ar: 'وصف مختصر لما يفعله هذا الوكيل',
  },
  instructionsPlaceholder: {
    en: 'System-level instructions for every run',
    ar: 'تعليمات على مستوى النظام لكل تشغيل',
  },
  emojiPlaceholder: {
    en: '🤖',
    ar: '🤖',
  },
  nameRequired: {
    en: 'Name is required',
    ar: 'الاسم مطلوب',
  },
  failedToLoadTemplates: {
    en: 'Failed to load templates',
    ar: 'فشل تحميل القوالب',
  },
  failedToLoadCatalog: {
    en: 'Failed to load capability catalog',
    ar: 'فشل تحميل دليل القدرات',
  },
} as const;

type LabelKey = keyof typeof AGENT_LABELS;

export function agentLabel(key: LabelKey): string {
  const locale = getLocale();
  return AGENT_LABELS[key][locale as Locale] ?? AGENT_LABELS[key].en;
}

export function modelDisplayName(model: string): string {
  if (!model || model === '__default__') return agentLabel('defaultModel');
  return model;
}
