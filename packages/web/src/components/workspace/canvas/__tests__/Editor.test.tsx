/**
 * Neo N2: the Canvas editor wrapper.
 *
 * The node detail sheet lists the recent tools that produced a node. The shell
 * (`WorkspacePanel`) hands the task's chat events to the editor it mounts, and
 * this wrapper is the link that carries them into the panel. The panel's own
 * test injects the events directly, so it cannot see this seam: the wiring was
 * broken once (the panel never received anything) and the panel test still
 * passed. These tests pin the wrapper itself.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolUsedEvent } from '@shared/socket';
import type { WorkspaceEditorProps } from '../../types';

// The panel renders through a live graph fetch and a server-sent stream; stub it
// so the test observes exactly what the wrapper forwards, nothing else.
vi.mock('../CanvasPanel', () => ({
  CanvasPanel: function CanvasPanelStub({ events }: { events?: ToolUsedEvent[] }) {
    const tools = events?.map((event) => event.type === 'toolUsed' && event.tool).filter(Boolean) ?? [];
    return (
      <div data-testid="canvas-panel-stub" data-tools={tools.join(',')}>
        {tools.length > 0 ? tools[tools.length - 1] : 'no-tools'}
      </div>
    );
  },
}));

import { Editor } from '../Editor';

function toolEvent(name: string, actionId: string): ToolUsedEvent {
  return {
    id: `ev-${actionId}`,
    type: 'toolUsed',
    tool: name,
    actionId,
    status: 'running',
    timestamp: Date.now(),
  } as ToolUsedEvent;
}

const props: WorkspaceEditorProps = {
  file: { taskId: 'task_editor_1', path: '__canvas_run__', name: 'Canvas', kind: 'canvas' },
  live: false,
  onSave: async () => {},
  onChatEdit: () => {},
};

describe('canvas workspace editor', () => {
  it('forwards the task chat events to the panel', () => {
    // Without this, the node detail's "Recent tools" list is always empty in
    // the real app even though the panel's own test passes.
    render(<Editor {...props} events={[toolEvent('web_search', 'a1')]} />);
    expect(screen.getByTestId('canvas-panel-stub')).toHaveAttribute('data-tools', 'web_search');
  });

  it('renders without events, so a caller that omits them is not broken', () => {
    // `events` is optional on the editor contract for the other editors.
    render(<Editor {...props} />);
    const stub = screen.getByTestId('canvas-panel-stub');
    expect(stub).toHaveAttribute('data-tools', '');
    expect(stub).toHaveTextContent('no-tools');
  });

});
