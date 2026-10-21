import { describe, expect, it } from 'vitest';
import {
  extensionOf,
  getEditorForFile,
  getEditorForKind,
  getEditorForPath,
  listEditors,
  registerEditor,
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
