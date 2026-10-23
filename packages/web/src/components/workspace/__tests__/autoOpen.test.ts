import { describe, expect, it } from 'vitest';
import type { ChatEvent, ChatMessageEvent, ServerAttachment, ToolUsedEvent } from '@shared/socket';
import { registerEditor } from '../registry';
import {
  decideUserMessageOpen,
  decideWorkspaceOpen,
  hasVideoEditIntent,
  isWorkspaceToolName,
  latestWorkspaceDecision,
} from '../autoOpen';

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

function videoAttachment(overrides: Partial<ServerAttachment> = {}): ServerAttachment {
  return {
    id: `att-${Math.random()}`,
    filename: 'clip.mp4',
    type: 'file',
    url: 'https://example.test/clip.mp4',
    contentType: 'video/mp4',
    contentLength: 1024,
    path: 'clip.mp4',
    ...overrides,
  };
}

describe('Loam Video auto-open intent', () => {
  it('opens loam-video for an English video edit intent', () => {
    const ev = userMessageEvent({ content: 'Please cut the intro and trim the end', attachments: [videoAttachment()] });
    expect(decideUserMessageOpen(ev)).toEqual({ path: 'clip.mp4', kind: 'loam-video', importPath: 'clip.mp4' });
  });

  it('opens loam-video for an Arabic video edit intent', () => {
    const ev = userMessageEvent({ content: 'عمل مونتاج للفيديو واضف موسيقى', attachments: [videoAttachment()] });
    expect(decideUserMessageOpen(ev)).toEqual({ path: 'clip.mp4', kind: 'loam-video', importPath: 'clip.mp4' });
  });

  it('does not open for a video with an unrelated question', () => {
    const ev = userMessageEvent({ content: 'What is this video about?', attachments: [videoAttachment()] });
    expect(decideUserMessageOpen(ev)).toBeNull();
  });

  it('opens the Craft editor for a document edit intent instead of the video studio', () => {
    const ev = userMessageEvent({
      content: 'Please cut the document',
      attachments: [videoAttachment({ filename: 'notes.pdf', path: 'notes.pdf', contentType: 'application/pdf' })],
    });
    // A PDF is a Loam Design file, so the edit intent routes to Craft rather than
    // the video studio, which never claims a non-video attachment.
    expect(decideUserMessageOpen(ev)).toEqual({ path: 'notes.pdf', kind: 'craft', craftApp: 'design' });
  });

  it('detects edit intent keywords in either language', () => {
    expect(hasVideoEditIntent('trim the last 5 seconds')).toBe(true);
    expect(hasVideoEditIntent('قص نهاية الفيديو')).toBe(true);
    expect(hasVideoEditIntent('what is in this video?')).toBe(false);
  });

  it('opens loam-video when the agent calls video_studio', () => {
    const ev = toolEvent({ tool: 'video_studio', argumentsDetail: { path: 'clip.mp4' } });
    expect(decideWorkspaceOpen(ev)).toEqual({ path: 'clip.mp4', kind: 'loam-video', importPath: 'clip.mp4' });
  });

  it('latestWorkspaceDecision prefers the newest video edit message', () => {
    const older = toolEvent({ tool: 'office_export', argumentsDetail: { path: 'a.docx' }, timestamp: 1 });
    const newer = userMessageEvent({ content: 'cut the video', attachments: [videoAttachment()], timestamp: 2 });
    const decision = latestWorkspaceDecision([older, newer] as ChatEvent[]);
    expect(decision?.event).toBe(newer);
    expect(decision?.target.kind).toBe('loam-video');
  });
});
