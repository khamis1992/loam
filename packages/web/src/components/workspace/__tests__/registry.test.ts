import { beforeEach, describe, expect, it } from 'vitest';
import {
  EDITOR_OVERRIDE_PREFIX,
  extensionOf,
  getEditorForFile,
  getEditorForKind,
  getEditorForPath,
  getEditorOverride,
  listEditors,
  listEditorsForPath,
  registerEditor,
  setEditorOverride,
  workspaceEditorsVersion,
} from '../registry';
import type { WorkspaceEditorDef } from '../types';

const docDef: WorkspaceEditorDef = {
  kind: 'doc',
  label: 'Doc test',
  extensions: ['docx', 'doc'],
  load: async () => ({ default: () => null }),
};
const sheetDef: WorkspaceEditorDef = {
  kind: 'sheet',
  label: 'Sheet test',
  extensions: ['.xlsx', 'CSV'],
  load: async () => ({ default: () => null }),
};
// Generation probes: `craft` and `loam-video` outrank the built-in editors.
const craftDef: WorkspaceEditorDef = {
  kind: 'craft',
  label: 'Craft test',
  extensions: ['docx'],
  load: async () => ({ default: () => null }),
};
const loamVideoDef: WorkspaceEditorDef = {
  kind: 'loam-video',
  label: 'Loam Video test',
  extensions: ['mp4'],
  load: async () => ({ default: () => null }),
};
const videoDef: WorkspaceEditorDef = {
  kind: 'video',
  label: 'Video test',
  extensions: ['mp4'],
  load: async () => ({ default: () => null }),
};

describe('workspace editor registry', () => {
  it('registers editors by kind and lists them', () => {
    const before = workspaceEditorsVersion();
    registerEditor(docDef);
    registerEditor(sheetDef);
    expect(workspaceEditorsVersion()).toBeGreaterThan(before);
    expect(listEditors().map((d) => d.kind)).toContain('doc');
    expect(getEditorForKind('sheet')).toBe(sheetDef);
    expect(getEditorForKind('video')).toBeNull();
  });

  it('resolves by extension, tolerating leading dots and case', () => {
    expect(getEditorForPath('reports/Quarterly.DOCX')).toBe(docDef);
    expect(getEditorForPath('data/budget.xlsx')).toBe(sheetDef);
    expect(getEditorForPath('data/notes.csv')).toBe(sheetDef);
  });

  it('returns null for unregistered extensions and extensionless paths', () => {
    expect(getEditorForPath('notes.txt')).toBeNull();
    expect(getEditorForPath('Makefile')).toBeNull();
  });

  it('prefers the path extension but falls back to the declared kind', () => {
    expect(
      getEditorForFile({ taskId: 't1', path: 'out/plan.docx', name: 'plan.docx', kind: 'doc' }),
    ).toBe(docDef);
    // kind declared doc but path looks like a sheet: extension wins.
    expect(
      getEditorForFile({ taskId: 't1', path: 'out/grid.xlsx', name: 'grid.xlsx', kind: 'doc' }),
    ).toBe(sheetDef);
    // unknown extension falls back to kind.
    expect(
      getEditorForFile({ taskId: 't1', path: 'out/legacy.odt', name: 'legacy.odt', kind: 'doc' }),
    ).toBe(docDef);
  });

  it('computes extensions from file names', () => {
    expect(extensionOf('a/b/video.mp4?v=2')).toBe('mp4');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('README')).toBe('');
  });
});

describe('workspace editor gateway (override + generations)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Re-register: the map replaces per kind, so this is idempotent whether or
    // not the earlier describe already registered these probes.
    registerEditor(docDef);
    registerEditor(sheetDef);
  });

  it('picks the best available editor generation for a contested extension', () => {
    // craft registers after doc but outranks it (3 > 2), matching the craft
    // registration's contract of owning every Loam Craft format.
    registerEditor(craftDef);
    expect(getEditorForPath('out/plan.docx')).toBe(craftDef);
    expect(listEditorsForPath('out/plan.docx')[0]).toBe(craftDef);
    // loam-video outranks the basic video player for the same extensions.
    registerEditor(videoDef);
    registerEditor(loamVideoDef);
    expect(getEditorForPath('media/clip.mp4')).toBe(loamVideoDef);
    expect(listEditorsForPath('media/clip.mp4')).toEqual([loamVideoDef, videoDef]);
  });

  it('an override wins over the extension match and persists in localStorage', () => {
    setEditorOverride('csv', 'doc');
    expect(getEditorOverride('csv')).toBe('doc');
    expect(window.localStorage.getItem(EDITOR_OVERRIDE_PREFIX + 'csv')).toBe('doc');
    expect(getEditorForPath('data/budget.csv')).toBe(docDef);
    expect(
      getEditorForFile({ taskId: 't1', path: 'data/budget.csv', name: 'budget.csv', kind: 'sheet' }),
    ).toBe(docDef);
  });

  it('an override wins even over the declared-kind fallback', () => {
    // No editor claims .odt: without an override the declared kind applies.
    // With one, the override must win instead.
    setEditorOverride('odt', 'sheet');
    expect(
      getEditorForFile({ taskId: 't1', path: 'out/legacy.odt', name: 'legacy.odt', kind: 'doc' }),
    ).toBe(sheetDef);
  });

  it('clearing the override restores the automatic pick', () => {
    setEditorOverride('csv', 'doc');
    setEditorOverride('csv', null);
    expect(getEditorOverride('csv')).toBeNull();
    expect(window.localStorage.getItem(EDITOR_OVERRIDE_PREFIX + 'csv')).toBeNull();
    expect(getEditorForPath('data/budget.csv')).toBe(sheetDef);
  });

  it('normalizes the extension when storing and reading overrides', () => {
    setEditorOverride('.DOCX', 'doc');
    expect(window.localStorage.getItem(EDITOR_OVERRIDE_PREFIX + 'docx')).toBe('doc');
    expect(getEditorOverride('docx')).toBe('doc');
    expect(getEditorOverride('.DOCX')).toBe('doc');
  });

  it('an override for an unregistered kind falls through to the auto pick', () => {
    setEditorOverride('csv', 'slides');
    expect(getEditorForPath('data/budget.csv')).toBe(sheetDef);
  });
});
