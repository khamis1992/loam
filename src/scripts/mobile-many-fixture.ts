import type { MobileProject, MobileScreen } from '../mobile/store.js';
/** Forty connected pages, with nested details and a cross-section link. */
export function manyPageProject(): MobileProject {
  const screens: MobileScreen[] = [];
  const groups = ['المكتبة', 'القراءة', 'الملاحظات', 'المجتمع', 'الحساب'];
  for (let g = 0; g < groups.length; g++) {
    const root = `section${g}`;
    screens.push({ id: root, title: groups[g]!, group: groups[g]!, kind: 'primary', blocks: [
      { id: `heading${g}`, type: 'heading', text: `مرحبًا في ${groups[g]!}` },
      ...Array.from({length: 6}, (_, j) => ({ id: `link${g}_${j+1}`, type: 'button' as const, text: `افتح ${groups[g]!} ${j+1}`, target: `${root}_page${j+1}` }))
    ] });
    for (let i = 1; i <= 7; i++) screens.push({
      id: `${root}_page${i}`, title: `${groups[g]!} ${i}`, group: groups[g]!, kind: 'detail', parentId: i===7 ? `${root}_page1` : root,
      blocks: [{ id: `field${g}_${i}`, type: 'input', text: `ملاحظة ${groups[g]!} ${i}` },
        ...(i===1 ? [{ id: `deep${g}`, type: 'button' as const, text: 'افتح التفاصيل المتقدمة', target: `${root}_page7` }] : []),
        ...(g===0&&i===7 ? [{ id: 'cross', type: 'button' as const, text: 'انتقل إلى الحساب 7', target: 'section4_page7' }] : [])]
    });
  }
  return { version: 1, revision: 0, title: 'مكتبة الحياة · تجربة 40 صفحة', accent: '#267965', direction: 'rtl', screens };
}
