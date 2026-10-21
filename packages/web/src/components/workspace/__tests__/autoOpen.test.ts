import { describe, expect, it } from 'vitest';
import type { ChatEvent, ToolUsedEvent } from '@shared/socket';
import { registerEditor } from '../registry';
import { decideWorkspaceOpen, isWorkspaceToolName, latestWorkspaceDecision } from '../autoOpen';

registerEditor({
  kind: 'doc',
  label: 'Doc',
  extensions: ['docx'],
  load: async () => ({ default: () => null }),
});
registerEditor({
  kind: 'video',
  label: 'Video',
  extensions: ['mp4'],
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

describe('workspace auto-open decision', () => {
  it('opens for a file whose extension matches a registered editor', () => {
    const ev = toolEvent({ tool: 'office_export', argumentsDetail: { path: 'out/report.docx' } });
    expect(decideWorkspaceOpen(ev)).toEqual({ path: 'out/report.docx', kind: 'doc' });
  });

  it('opens for extension matches even on non-office tools', () => {
    const ev = toolEvent({ tool: 'text_editor', argumentsDetail: { path: 'clips/intro.mp4' } });
    expect(decideWorkspaceOpen(ev)).toEqual({ path: 'clips/intro.mp4', kind: 'video' });
  });

  it('opens for office_*/video tools without an editor-recognized path', () => {
    expect(isWorkspaceToolName('office_craft')).toBe(true);
    expect(isWorkspaceToolName('video_studio')).toBe(true);
    expect(isWorkspaceToolName('terminal')).toBe(false);
    const ev = toolEvent({ tool: 'office_status' });
    expect(decideWorkspaceOpen(ev)).toEqual({ path: null, kind: null });
  });

  it('ignores unrelated tools and non-editor paths', () => {
    const ev = toolEvent({ tool: 'terminal', argumentsDetail: { command: 'ls', path: 'notes.txt' } });
    expect(decideWorkspaceOpen(ev)).toBeNull();
  });

  it('finds a path inside a description when structured fields are absent', () => {
    const ev = toolEvent({ tool: 'office_export', description: 'Saved deck to slides/keynote.pptx.' });
    const target = decideWorkspaceOpen(ev);
    expect(target?.path).toBe('slides/keynote.pptx');
  });

  it('latestWorkspaceDecision returns the newest qualifying event', () => {
    const first = toolEvent({ tool: 'terminal', argumentsDetail: { command: 'echo hi' }, timestamp: 1 });
    const second = toolEvent({ tool: 'office_export', argumentsDetail: { path: 'a.docx' }, timestamp: 2 });
    const third = toolEvent({ tool: 'browser_navigate', argumentsDetail: { url: 'https://x.test' }, timestamp: 3 });
    const decision = latestWorkspaceDecision([first, second, third] as ChatEvent[]);
    expect(decision?.event).toBe(second);
    expect(decision?.target).toEqual({ path: 'a.docx', kind: 'doc' });
    expect(latestWorkspaceDecision([first, third] as ChatEvent[])).toBeNull();
  });
});
