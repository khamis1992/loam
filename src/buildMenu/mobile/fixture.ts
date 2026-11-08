import type { MobileProject } from '../../mobile/store.js';

export function starterMobile(): MobileProject {
  return {
    version: 1,
    revision: 1,
    title: 'دفتر محلي',
    accent: '#177E89',
    direction: 'rtl',
    screens: [{
      id: 'home',
      title: 'دفتر',
      kind: 'primary',
      blocks: [
        { id: 'note', type: 'input', text: 'ملاحظتي', placeholder: 'اكتب ملاحظة' },
        { id: 'done', type: 'toggle', text: 'مكتملة' },
      ],
    }],
  };
}
