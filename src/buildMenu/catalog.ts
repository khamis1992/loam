import type { BuildKind, BuildProfile } from '../../packages/shared/src/buildMenu.js';
import { websiteProfile } from './websites/profile.js';
import { desktopProfile } from './desktop/profile.js';
import { widgetProfile } from './widget/profile.js';
import { automationProfile } from './automations/profile.js';
import { notebookProfile } from './notebooks/profile.js';
import { mobileProfile } from './mobile/profile.js';
import { chromeProfile } from './chrome/profile.js';
import { safariProfile } from './safari/profile.js';
import { gameProfile } from './games/profile.js';

export type BuildEngine =
  | 'loam-build'
  | 'loam-desktop'
  | 'loam-schedule'
  | 'notebook-ipynb'
  | 'loam-mobile'
  | 'extension-source'
  | 'loam-game';

const profiles: readonly BuildProfile[] = [
  websiteProfile,
  desktopProfile,
  widgetProfile,
  automationProfile,
  notebookProfile,
  mobileProfile,
  chromeProfile,
  safariProfile,
  gameProfile,
];

export function listProfiles(): readonly BuildProfile[] {
  return profiles;
}

export function profileFor(kind: BuildKind): BuildProfile {
  const profile = profiles.find((item) => item.kind === kind);
  if (!profile) throw new Error(`missing_requirement:${kind}`);
  return profile;
}

export function engineFor(kind: BuildKind): BuildEngine {
  switch (kind) {
    case 'website':
      return 'loam-build';
    case 'desktop':
    case 'widget':
      return 'loam-desktop';
    case 'automation':
      return 'loam-schedule';
    case 'notebook':
      return 'notebook-ipynb';
    case 'mobile':
      return 'loam-mobile';
    case 'chrome-extension':
    case 'safari-extension':
      return 'extension-source';
    case 'game':
      return 'loam-game';
    default: {
      const unknown: never = kind;
      throw new Error(`missing_requirement:${unknown}`);
    }
  }
}

const promptFacts: Record<BuildKind, { files: readonly string[]; permissions: string }> = {
  website: {
    files: ['app/preview.html', 'app/loam-website.json'],
    permissions: 'لا دفع ولا مفاتيح ولا سكربت تثبيت.',
  },
  desktop: {
    files: ['app/dist/index.html'],
    permissions: 'لا autostart ولا جسر Loam ولا تنفيذ main مولّد.',
  },
  widget: {
    files: ['app/dist/index.html'],
    permissions: 'لا طلب شبكة ولا صلاحيات عامة.',
  },
  automation: {
    files: ['app/preview.html', 'app/schedule.txt', 'app/README.md'],
    permissions: 'لا إرسال ولا نشر ولا حذف ملفات.',
  },
  notebook: {
    files: ['app/notebook.ipynb'],
    permissions: 'لا pip ولا صورة latest ولا شبكة الحاوية.',
  },
  mobile: {
    files: ['app/simulation.html'],
    permissions: 'لا sync ولا دفع ولا توقيع متجر.',
  },
  'chrome-extension': {
    files: ['app/popup.html', 'app/manifest.json'],
    permissions: 'لا all_urls ولا background ولا تحميل على ملف المستخدم.',
  },
  'safari-extension': {
    files: ['app/popup.html', 'app/manifest.json'],
    permissions: 'لا تحويل Xcode على غير macOS ولا رفع متجر.',
  },
  game: {
    files: ['app/index.html', 'app/tuning.json', 'app/LICENSE', 'app/assets/manifest.json'],
    permissions: 'لا أصول خارجية ولا موسيقى مجهولة الترخيص.',
  },
};

function networkLimit(network: BuildProfile['network']): string {
  switch (network) {
    case 'none':
      return 'بلا شبكة';
    case 'loopback':
      return 'استرجاع محلي فقط';
    default: {
      const unknown: never = network;
      throw new Error(`missing_requirement:${unknown}`);
    }
  }
}

export function arabicPromptTemplate(kind: BuildKind): string {
  const profile = profileFor(kind);
  const facts = promptFacts[profile.kind];
  return [
    'قالب تعليمات محلي ثابت، ولا يستدعي نموذجاً.',
    `النوع: ${profile.kind}.`,
    `الملفات المحلية المسموحة: ${facts.files.join('، ')}.`,
    `حدود الصلاحيات: ${facts.permissions} الشبكة: ${networkLimit(profile.network)}. كل أثر خارجي يتطلب موافقة.`,
  ].join('\n');
}
