/**
 * Neo N14: the shared run replay.
 *
 * A shared task is public, so the replay it carries has to be safe to show to
 * anyone holding the link: it renders only what the server published (the
 * sanitized bundle), and it offers no action that changes anything. The
 * scrubber only reveals nodes the agent had already produced.
 *
 * Playwright is not available in this harness, so the component is pinned here
 * with the real `ReplaySection` and an injected bundle: the same render path,
 * no network. The sanitization itself is asserted server-side
 * (`src/graph/__tests__/export.test.ts`), and the share feed test there proves
 * the bundle arrives with `redactions` counted.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ReplaySection, type SharedReplay } from '../ShareReplay';

function replay(overrides: Partial<SharedReplay> = {}): SharedReplay {
  return {
    runId: 'task_share_replay_1',
    title: 'Publish the quarterly report',
    nodes: [
      { id: 'root', parent_ids: [], type: 'question', status: 'finished', data: { title: 'Publish the report' } },
      { id: 'search', parent_ids: ['root'], type: 'search', status: 'finished', data: { query: 'revenue' } },
      { id: 'doc', parent_ids: ['search'], type: 'document', status: 'finished', data: { path: 'report.md' } },
    ],
    edges: [
      { from: 'root', to: 'search' },
      { from: 'search', to: 'doc' },
    ],
    frames: [
      { index: 0, nodeId: 'root', type: 'question', status: 'finished', label: 'Publish the report' },
      { index: 1, nodeId: 'search', type: 'search', status: 'finished', label: 'revenue' },
      { index: 2, nodeId: 'doc', type: 'document', status: 'finished', label: 'report.md' },
    ],
    outputs: [{ path: 'report.md', kind: 'document', mime: 'text/markdown', sizeBytes: 12 }],
    stats: {
      totalNodes: 3,
      nodesByType: { question: 1, search: 1, document: 1 },
      nodesByStatus: { finished: 3 },
      edges: 2,
      depth: 2,
      durationMs: 2000,
    },
    redactions: 1,
    partial: false,
    ...overrides,
  };
}

describe('shared run replay', () => {
  it('renders the sanitized run as a read-only timeline', () => {
    render(<ReplaySection replay={replay()} />);

    expect(screen.getByTestId('share-replay')).toBeTruthy();
    // The scrubber is the only control, and it is a read-only range input.
    expect(screen.getByRole('slider')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    // The timeline and the produced-files list both name report.md.
    expect(screen.getAllByText('report.md')).toHaveLength(2);
    // The bundle reports how many credentials the server removed.
    expect(screen.getByTestId('share-replay')).toHaveTextContent('1 credentials removed');
  });

  it('scrubbing reveals nodes in order and never hides the run head', () => {
    render(<ReplaySection replay={replay()} />);
    const scrubber = screen.getByTestId('share-replay-scrubber') as HTMLInputElement;
    // Only the timeline list carries frames; the outputs list is a sibling.
    const frames = () => within(screen.getByTestId('share-replay-timeline')).getAllByRole('listitem');

    // The section opens on the last frame, so the whole run is visible.
    expect(scrubber.value).toBe('2');

    fireEvent.change(scrubber, { target: { value: '0' } });
    const first = frames().filter((frame) => !frame.className.includes('opacity-40'));
    expect(first).toHaveLength(1);
    expect(first[0]!.textContent).toContain('Publish the report');

    fireEvent.change(scrubber, { target: { value: '1' } });
    expect(frames().filter((frame) => !frame.className.includes('opacity-40'))).toHaveLength(2);
  });

  it('marks a partial run and omits the redaction note when nothing was stripped', () => {
    render(<ReplaySection replay={replay({ partial: true, redactions: 0 })} />);

    expect(screen.getByTestId('share-replay')).toHaveTextContent(
      'This run was still in progress when it was exported.',
    );
    expect(screen.getByTestId('share-replay').textContent).not.toContain('credentials removed');
  });

  it('falls back to the node payload when a frame has no label of its own', () => {
    render(<ReplaySection replay={replay({ frames: replay().frames.map((frame) => ({ ...frame, label: '' })) })} />);
    // The document node carries `path`, which the section reads as its label.
    expect(screen.getAllByText('report.md')).toHaveLength(2);
  });
});
