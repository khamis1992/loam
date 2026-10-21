import type { ChatEvent, ToolUsedEvent } from '@shared/socket';
import { getEditorForPath } from './registry';
import type { WorkspaceKind } from './types';

export interface WorkspaceOpenTarget {
  /** Path of the file to select in the workspace panel, when the event named one. */
  path: string | null;
  /** Editor kind implied by the file extension; null for generic office/video tools. */
  kind: WorkspaceKind | null;
}

/** Tools that produce editable workspace artifacts even without a file extension match. */
export function isWorkspaceToolName(tool: string): boolean {
  const name = (tool ?? '').toLowerCase();
  return (
    name.startsWith('office_') ||
    name.startsWith('video') ||
    name.startsWith('docx') ||
    name.startsWith('xlsx') ||
    name.startsWith('pptx') ||
    name.startsWith('slides') ||
    name.startsWith('sheet') ||
    name.includes('_video') ||
    name.includes('docx') ||
    name.includes('xlsx') ||
    name.includes('pptx')
  );
}

function candidatePath(event: ToolUsedEvent): string | null {
  const sources: unknown[] = [event.argumentsDetail, event.detail];
  for (const raw of sources) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    for (const key of ['path', 'file', 'filePath', 'outputPath', 'output', 'savePath', 'dest']) {
      const v = rec[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    const nested = rec['result'] ?? rec['output'];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const n = nested as Record<string, unknown>;
      for (const key of ['path', 'file', 'filePath']) {
        const v = n[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  const text = [event.brief ?? '', event.description ?? ''].join(' ');
  const match = text.match(/[\w./\\-]+\.(mp4|mov|webm|mkv|docx|xlsx|pptx)(?=[\s,.;)]|$)/i);
  return match ? match[0] : null;
}

/** Decide whether a tool event should open the right panel on the Workspace tab. */
export function decideWorkspaceOpen(event: ToolUsedEvent): WorkspaceOpenTarget | null {
  const path = candidatePath(event);
  if (path) {
    const editor = getEditorForPath(path);
    if (editor) return { path, kind: editor.kind };
    if (isWorkspaceToolName(event.tool)) return { path, kind: null };
    return null;
  }
  if (isWorkspaceToolName(event.tool)) return { path: null, kind: null };
  return null;
}

/** Latest event in the task that qualifies for workspace auto-open. */
export function latestWorkspaceDecision(
  events: ChatEvent[],
): { event: ToolUsedEvent; target: WorkspaceOpenTarget } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type !== 'toolUsed') continue;
    const target = decideWorkspaceOpen(e as ToolUsedEvent);
    if (target) return { event: e as ToolUsedEvent, target };
  }
  return null;
}
