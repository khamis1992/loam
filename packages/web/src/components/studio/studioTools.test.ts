import { describe, expect, it } from 'vitest';
import { STATIC_STUDIO_TOOLS, pickStudioTools, type StudioToolKind } from './studioTools';

const KINDS: StudioToolKind[] = ['video', 'document', 'spreadsheet', 'presentation', 'design'];

describe('STATIC_STUDIO_TOOLS', () => {
  it('lists the five studio launcher kinds with distinct ids and modes', () => {
    expect(STATIC_STUDIO_TOOLS.map((t) => t.kind).sort()).toEqual([...KINDS].sort());
    expect(new Set(STATIC_STUDIO_TOOLS.map((t) => t.id)).size).toBe(5);
    for (const tool of STATIC_STUDIO_TOOLS) {
      expect(tool.loamMode).toBeTruthy();
      expect(tool.prompt).toBeTruthy();
    }
    expect(STATIC_STUDIO_TOOLS.find((t) => t.kind === 'document')?.loamMode).toBe('write');
    expect(STATIC_STUDIO_TOOLS.find((t) => t.kind === 'spreadsheet')?.loamMode).toBe('data');
    expect(STATIC_STUDIO_TOOLS.find((t) => t.kind === 'video')?.loamMode).toBe('media');
  });
});

describe('pickStudioTools', () => {
  it('returns null when the payload carries no tool list', () => {
    expect(pickStudioTools(null)).toBeNull();
    expect(pickStudioTools(undefined)).toBeNull();
    expect(pickStudioTools('studio')).toBeNull();
    expect(pickStudioTools({ artifact: null })).toBeNull();
    expect(pickStudioTools({ tools: [] })).toBeNull();
    expect(pickStudioTools({ tools: [{ kind: 'unknown' }] })).toBeNull();
  });

  it('normalizes a CR1 GET /api/studio payload, filling defaults per kind', () => {
    const listed = pickStudioTools({
      tools: [
        { kind: 'document', name: 'Office Doc' },
        { kind: 'sheet-like', id: 'ignored' },
        { id: 'custom', prompt: 'x' },
      ],
    });
    expect(listed).not.toBeNull();
    expect(listed).toHaveLength(1);
    const doc = listed![0];
    expect(doc.kind).toBe('document');
    expect(doc.label).toBe('Office Doc');
    expect(doc.loamMode).toBe('write');
    expect(doc.subtitle).toBe('Draft and export documents');
  });

  it('keeps explicit mode and prompt from the backend', () => {
    const listed = pickStudioTools({
      tools: [{ kind: 'spreadsheet', id: 'grid', mode: 'data', prompt: 'Build a grid', subtitle: 'Grids' }],
    });
    expect(listed).toHaveLength(1);
    expect(listed![0]).toMatchObject({
      id: 'grid', kind: 'spreadsheet', loamMode: 'data', prompt: 'Build a grid', subtitle: 'Grids',
    });
  });
});
