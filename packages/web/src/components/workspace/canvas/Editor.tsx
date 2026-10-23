'use client';

/**
 * `canvas` Workspace editor. Renders the run graph of the task (N1) with live
 * updates, pan/zoom, an Organize action and the Recipe side panel.
 */
import { CanvasPanel } from './CanvasPanel';
import type { WorkspaceEditorProps } from '../types';

export function Editor({ file, live, events }: WorkspaceEditorProps) {
  // The node detail lists the recent tools that produced a node, so the chat
  // events have to reach the panel (the shell wires them through).
  return <CanvasPanel taskId={file.taskId} live={live} events={events ?? []} />;
}

export default Editor;
