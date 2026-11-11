import { describe, expect, it } from 'vitest';
import { getEditorForPath, listEditors } from '../registry';
// Importing the registration module has the side effect that matters: it registers
// the `craft` editor the Workspace panel mounts for Craft files. Importing the
// workspace index re-runs it in the same process, which the map silently ignores.
import '../craft/register';
import '..';
import { craftAppForExtension } from '../craft';

describe('craft editor registration (cr-03)', () => {
  it('registers a craft editor that covers every app family', () => {
    const def = listEditors().find((d) => d.kind === 'craft');
    expect(def).toBeDefined();
    expect(def?.label).toBe('Loam Craft');
    expect(def?.extensions).toEqual(expect.arrayContaining(['docx', 'xlsx', 'pptx', 'png', 'pdf']));
  });

  it('resolves each Craft file type to the craft editor', () => {
    for (const [path, app] of [
      ['notes/plan.docx', 'docs'],
      ['data/budget.xlsx', 'sheets'],
      ['deck/deck.pptx', 'slides'],
      ['shots/art.png', 'photo'],
      ['cover/layout.pdf', 'design'],
    ] as Array<[string, string]>) {
      expect(getEditorForPath(path)?.kind).toBe('craft');
      expect(craftAppForExtension(path.split('.').pop() ?? '')).toBe(app);
    }
  });

  it('loads the craft editor component lazily', async () => {
    const def = listEditors().find((d) => d.kind === 'craft');
    const loaded = await def?.load();
    expect(loaded?.default).toBeTypeOf('function');
  });

  it('leaves non-web types to the built-in editors', () => {
    // A file with no extension has no editor to claim it.
    expect(getEditorForPath('Makefile')).toBeNull();
    // Plain text is a web/code artifact, so the web editor owns it.
    expect(getEditorForPath('notes/readme.txt')?.kind).toBe('web');
    expect(getEditorForPath('src/app.tsx')?.kind).toBe('web');
  });
});
