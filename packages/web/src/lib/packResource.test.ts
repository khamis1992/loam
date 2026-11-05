import { describe, expect, it } from 'vitest';
import { packResourceMediaUrl, packResourceTarget, parsePackResource } from './packResource';

describe('pack resource links', () => {
  it('opens slides and video in the existing workspace surfaces', () => {
    const slides = parsePackResource('loam-resource://loam-slides/deck/task_1')!;
    expect(packResourceTarget(slides, 'uploads/deck.pptx')).toEqual({ kind: 'craft', craftApp: 'slides', path: 'uploads/deck.pptx' });
    expect(packResourceMediaUrl(slides, 'uploads/deck.pptx')).toContain('taskId=task_1');
    const video = parsePackResource('loam-resource://loam-video/video/task_2')!;
    expect(packResourceTarget(video, 'uploads/video.mp4')).toEqual({ kind: 'loam-video', path: 'uploads/video.mp4' });
    const local = parsePackResource('loam-resource://loam-localfile/file/task_3')!;
    expect(packResourceTarget(local, 'uploads/deck.pptx')).toEqual({ kind: 'craft', craftApp: 'slides', path: 'uploads/deck.pptx' });
    expect(packResourceTarget(local, 'uploads/notes.md')).toEqual({ kind: 'doc', path: 'uploads/notes.md' });
  });

  it('rejects unknown schemes and unrelated packs', () => {
    expect(parsePackResource('https://example.com/file.pptx')).toBeNull();
    expect(packResourceTarget({ packId: 'unknown', kind: 'deck', projectId: 'task_1' }, 'uploads/deck.pptx')).toBeNull();
  });
});
