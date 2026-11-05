import { describe, expect, it } from 'vitest';
import { answerNativeBridge } from '../recorder/nativeBridge';

describe('recorder native bridge', () => {
  it('opens the Arabic sample project and rejects an unknown action', () => {
    const listed = answerNativeBridge({
      requestId: 'list',
      domain: 'aiEdition',
      action: 'document.listProjects',
    }) as { ok: boolean; data: Array<{ id: string; title: string }> };
    expect(listed.ok).toBe(true);
    expect(listed.data[0]?.title).toBe('تسجيل الشاشة');

    const opened = answerNativeBridge({
      requestId: 'get',
      domain: 'aiEdition',
      action: 'document.get',
      payload: { projectId: listed.data[0]?.id },
    }) as { ok: boolean; data: { success: boolean; document: { schemaVersion: number; project: { title: string }; annotations: Array<{ content: string }>; assets: Array<{ originalPath: string }> } } };
    expect(opened.data.success).toBe(true);
    expect(opened.data.document.schemaVersion).toBe(9);
    expect(opened.data.document.project.title).toBe('تسجيل الشاشة');
    const captions = opened.data.document.annotations;
    expect(captions[0]?.content).toBe('مرحبا بكم في قطر');
    const assets = opened.data.document.assets as Array<{ originalPath: string }>;
    expect(assets[0]?.originalPath).toBe('loamrecorder://app/desktop.mp4');

    const created = answerNativeBridge({
      requestId: 'new',
      domain: 'aiEdition',
      action: 'document.create',
      payload: { title: 'مشروع جديد' },
    }) as { data: { document: { annotations: unknown[] } } };
    expect(created.data.document.annotations).toEqual([]);

    const rejected = answerNativeBridge({
      requestId: 'nope',
      domain: 'aiEdition',
      action: 'llm.getSnapshot',
    }) as { ok: boolean; error: { code: string } };
    expect(rejected.ok).toBe(false);
    expect(rejected.error.code).toBe('UNSUPPORTED_ACTION');
  });
});
