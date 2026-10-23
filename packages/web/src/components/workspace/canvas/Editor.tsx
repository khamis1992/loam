'use client';

/**
 * `canvas` Workspace editor. Renders the run graph of the task (N1) with live
 * updates, pan/zoom, an Organize action and the Recipe side panel.
 */
import { CanvasPanel } from './CanvasPanel';
import type { WorkspaceEditorProps } from '../types';

export function Editor({ file, live }: WorkspaceEditorProps) {
  return <CanvasPanel taskId={file.taskId} live={live} />;
}

export default Editor;
