import { describe, expect, it } from 'vitest';
import type { ChatEvent, ChatMessageEvent, ServerAttachment, ToolUsedEvent } from '@shared/socket';
import { registerEditor } from '../registry';
import {
  decideUserMessageOpen,
  decideWorkspaceOpen,
  hasCraftEditIntent,
  isWorkspaceToolName,
  latestWorkspaceDecision,
} from '../autoOpen';
import { craftAppForExtension, editorKindForExtension, isPreviewOnlyExt } from '../craft';

// The `craft` editor registration is what the Workspace panel mounts for these files
// (see craft/register.ts). Registering it here mirrors the real app so the decision
// tests resolve a `craft` kind the same way the panel does.
registerEditor({
  kind: 'craft',
  label: 'Loam Craft',
  extensions: [
    '.docx', 'docx', '.docm', 'docm', '.dotx', 'dotx', '.doc', 'doc', '.odt', 'odt', '.rtf', 'rtf',
    '.xlsx', 'xlsx', '.xlsm', 'xlsm', '.xls', 'xls', '.csv', 'csv', '.ods', 'ods',
    '.pptx', 'pptx', '.ppt', 'ppt', '.odp', 'odp',
    '.psd', 'psd', '.png', 'png', '.jpg', 'jpg', '.jpeg', 'jpeg', '.webp', 'webp',
    '.tif', 'tif', '.tiff', 'tiff', '.heic', 'heic', '.avif', 'avif', '.bmp', 'bmp', '.gif', 'gif',
    '.idml', 'idml', '.indd', 'indd', '.pdf', 'pdf',
  ],
  load: async () => ({ default: () => null }),
});
registerEditor({
  kind: 'doc',
  label: 'Doc',
  extensions: ['docx'],
  load: async () => ({ default: () => null }),
});

function toolEvent(partial: Partial<ToolUsedEvent> & { tool: string }): ToolUsedEvent {
  return {
    id: partial.id ?? `id-${Math.random()}`,
    timestamp: partial.timestamp ?? Date.now(),
    type: 'toolUsed',
    actionId: partial.actionId ?? `act-${Math.random()}`,
    status: 'running',
    ...partial,
  } as ToolUsedEvent;
}

function userMessageEvent(partial: Partial<ChatMessageEvent> & { content: string }): ChatMessageEvent {
  return {
    id: `msg-${Math.random()}`,
    timestamp: Date.now(),
    type: 'chat',
    sender: 'user',
    messageType: 'text',
    attachments: [],
    ...partial,
  } as ChatMessageEvent;
}

function attachment(overrides: Partial<ServerAttachment> = {}): ServerAttachment {
  return {
    id: `att-${Math.random()}`,
    filename: 'plan.docx',
    type: 'file',
    url: 'https://example.test/plan.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    contentLength: 1024,
    path: 'plan.docx',
    ...overrides,
  };
}

describe('craft routing', () => {
  it('resolves each file family to the app that owns it', () => {
    expect(craftAppForExtension('docx')).toBe('docs');
    expect(craftAppForExtension('.xlsx')).toBe('sheets');
    expect(craftAppForExtension('pptx')).toBe('slides');
    expect(craftAppForExtension('png')).toBe('photo');
    expect(craftAppForExtension('idml')).toBe('design');
    expect(craftAppForExtension('pdf')).toBe('design');
    expect(craftAppForExtension('mp4')).toBeNull();
  });

  it('maps craft extensions to the craft editor kind', () => {
    expect(editorKindForExtension('docx')).toBe('craft');
    expect(editorKindForExtension('csv')).toBe('craft');
    expect(editorKindForExtension('indd')).toBe('craft');
    // The built-in editors keep owning their plain types when no Craft app does.
    expect(editorKindForExtension('txt')).toBeNull();
  });

  it('treats .indd as preview-only and not editable', () => {
    expect(isPreviewOnlyExt('indd')).toBe(true);
    expect(isPreviewOnlyExt('layout.indd')).toBe(false);
    expect(isPreviewOnlyExt('pdf')).toBe(false);
  });
});

describe('craft edit intent', () => {
  it('detects edit intent in English and Arabic', () => {
    expect(hasCraftEditIntent('edit the first paragraph')).toBe(true);
    expect(hasCraftEditIntent('retouch this photo and crop it')).toBe(true);
    expect(hasCraftEditIntent('\u0635\u0645\u0651\u0645 \u0627\u0644\u063a\u0644\u0627\u0641 \u0648\u0623\u0636\u0641 \u0628\u0637\u0627\u0642\u0629')).toBe(true);
    expect(hasCraftEditIntent('\u0623\u0636\u0641 \u062a\u0623\u062b\u064a\u0631 \u0627\u0644\u0623\u0632\u0631\u0642 \u0639\u0644\u064a\u0647\u0627')).toBe(true);
    expect(hasCraftEditIntent('what is this file about?')).toBe(false);
    expect(hasCraftEditIntent('')).toBe(false);
  });

  it('opens craft for an English edit request with an attached document', () => {
    const ev = userMessageEvent({ content: 'please edit the first slide and fix the typo', attachments: [attachment()] });
    expect(decideUserMessageOpen(ev)).toEqual({ path: 'plan.docx', kind: 'craft', craftApp: 'docs' });
  });

  it('opens craft for an Arabic edit request with an attached photo', () => {
    const ev = userMessageEvent({
      content: '\u0623\u0636\u0641 \u062a\u0623\u062b\u064a\u0631 \u0627\u0644\u0623\u0632\u0631\u0642 \u0639\u0644\u064a\u0647\u0627',
      attachments: [attachment({ filename: 'hero.png', path: 'hero.png', contentType: 'image/png' })],
    });
    expect(decideUserMessageOpen(ev)).toEqual({ path: 'hero.png', kind: 'craft', craftApp: 'photo' });
  });

  it('resolves the craft app from the extension for each family', () => {
    const cases: Array<[string, string]> = [
      ['budget.xlsx', 'sheets'],
      ['deck.pptx', 'slides'],
      ['logo.psd', 'photo'],
      ['cover.pdf', 'design'],
    ];
    for (const [name, app] of cases) {
      const ev = userMessageEvent({
        content: 'edit this file',
        attachments: [attachment({ filename: name, path: name })],
      });
      expect(decideUserMessageOpen(ev)).toEqual({ path: name, kind: 'craft', craftApp: app });
    }
  });

  it('does not open craft for an unrelated question about an attachment', () => {
    const ev = userMessageEvent({ content: 'what is this file about?', attachments: [attachment()] });
    expect(decideUserMessageOpen(ev)).toBeNull();
  });

  it('does not open craft without an edit intent', () => {
    const ev = userMessageEvent({ content: 'thanks, looks great', attachments: [attachment()] });
    expect(decideUserMessageOpen(ev)).toBeNull();
  });

  it('never routes a video attachment to craft', () => {
    const ev = userMessageEvent({
      content: 'edit the first paragraph of the document',
      attachments: [attachment({ filename: 'clip.mp4', path: 'clip.mp4', contentType: 'video/mp4' })],
    });
    // The dedicated video editor owns it, so Craft never claims a video.
    expect(decideUserMessageOpen(ev)).toEqual({
      importPath: 'clip.mp4',
      kind: 'loam-video',
      path: 'clip.mp4',
    });
  });
});

describe('craft tool routing', () => {
  it('recognizes craft tool names', () => {
    expect(isWorkspaceToolName('office_craft')).toBe(true);
    expect(isWorkspaceToolName('office_craft_write')).toBe(true);
    expect(isWorkspaceToolName('loam_design')).toBe(true);
    expect(isWorkspaceToolName('terminal')).toBe(false);
  });

  it('opens the craft panel when the craft tool names a file', () => {
    const ev = toolEvent({ tool: 'office_craft', argumentsDetail: { path: 'out/deck.pptx' } });
    expect(decideWorkspaceOpen(ev)).toEqual({ path: 'out/deck.pptx', kind: 'craft', craftApp: 'slides' });
  });

  it('opens the craft panel for a path found in the tool description', () => {
    const ev = toolEvent({ tool: 'office_craft', description: 'Saved the sheet to data/budget.xlsx.' });
    expect(decideWorkspaceOpen(ev)).toEqual({ path: 'data/budget.xlsx', kind: 'craft', craftApp: 'sheets' });
  });

  it('keeps the craft kind for a craft tool without a path', () => {
    const ev = toolEvent({ tool: 'office_craft' });
    expect(decideWorkspaceOpen(ev)).toEqual({ path: null, kind: 'craft' });
  });

  it('does not open the workspace for unrelated tools', () => {
    const ev = toolEvent({ tool: 'terminal', argumentsDetail: { command: 'ls' } });
    expect(decideWorkspaceOpen(ev)).toBeNull();
  });

  it('latestWorkspaceDecision prefers the newest craft edit message', () => {
    const older = toolEvent({ tool: 'office_craft', argumentsDetail: { path: 'a.docx' }, timestamp: 1 });
    const newer = userMessageEvent({
      content: '\u0639\u062f\u0651\u0644 \u0627\u0644\u0641\u0642\u0631\u0629 \u0627\u0644\u0623\u0648\u0644\u0649',
      attachments: [attachment({ filename: 'hero.png', path: 'hero.png' })],
      timestamp: 2,
    });
    const decision = latestWorkspaceDecision([older, newer] as ChatEvent[]);
    expect(decision?.event).toBe(newer);
    expect(decision?.target).toEqual({ path: 'hero.png', kind: 'craft', craftApp: 'photo' });
  });
});
