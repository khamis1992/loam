import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceEditorProps } from '../../types';
import { AttachmentCard } from '@/components/chat/AttachmentCard';
import { Editor } from '../Editor';

/**
 * The panel itself is covered by `craft/CraftPanel.test.tsx`. This file covers the
 * `craft` workspace editor shell: which Craft app it mounts for a file, and that a
 * save lands in the task's files through `/api/upload` (the same place cr-02's panel
 * stores exports).
 */
vi.mock('../CraftPanel', () => ({
  craftSaveMime: (name: string) => (name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
  CraftPanel: (props: {
    app: string;
    path: string;
    uploadBytes: (taskId: string, name: string, bytes: Uint8Array) => Promise<void>;
  }) => (
    <button
      type="button"
      data-testid="craft-panel"
      data-app={props.app}
      data-path={props.path}
      onClick={() => props.uploadBytes('t1', 'plan.docx', new Uint8Array([1, 2, 3]))}
    >
      craft-save
    </button>
  ),
}));

function propsFor(path: string, mime?: string): WorkspaceEditorProps {
  return {
    file: { taskId: 't1', path, name: path.split('/').pop() ?? path, kind: 'craft', mime },
    live: false,
    onSave: async () => {},
    onChatEdit: () => {},
  };
}

describe('craft workspace Editor', () => {
  it('opens the file in the app that owns its extension', () => {
    const view = render(<Editor {...propsFor('notes/plan.docx')} />);
    expect(within(view.container).getByTestId('craft-panel')).toHaveAttribute('data-app', 'docs');
  });

  it('routes each family to its own app', () => {
    for (const [path, app] of [
      ['data/budget.xlsx', 'sheets'],
      ['deck/deck.pptx', 'slides'],
      ['shots/art.png', 'photo'],
      ['cover/layout.pdf', 'design'],
    ] as Array<[string, string]>) {
      const view = render(<Editor {...propsFor(path)} />);
      expect(within(view.container).getByTestId('craft-panel')).toHaveAttribute('data-app', app);
      view.unmount();
    }
  });

  it('passes the task file path through to the app', () => {
    const view = render(<Editor {...propsFor('notes/plan.docx')} />);
    expect(within(view.container).getByTestId('craft-panel')).toHaveAttribute('data-path', 'notes/plan.docx');
  });

  it('falls back to the MIME type when the extension is unrecognised', () => {
    const view = render(<Editor {...propsFor('download/file', 'application/pdf')} />);
    expect(within(view.container).getByTestId('craft-panel')).toHaveAttribute('data-app', 'design');
  });

  it('shows a notice when no Craft app can edit the file', () => {
    const view = render(<Editor {...propsFor('notes/readme.txt')} />);
    expect(within(view.container).getByText(/no workspace editor yet/i)).toBeInTheDocument();
  });

  it('uploads a craft:save payload to the task files', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<Editor {...propsFor('notes/plan.docx')} />);
    fireEvent.click(within(view.container).getByText('craft-save'));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/api/upload?taskId=t1&name=plan.docx');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(Blob);
  });
});

describe('AttachmentCard open-in-editor action', () => {
  it('keeps the plain Open label without an editor action', () => {
    const view = render(<AttachmentCard name="plan.docx" taskId="t1" path="plan.docx" />);
    const button = within(view.container).getByRole('button');
    expect(button).toHaveTextContent('Open');
    expect(button).not.toHaveAttribute('title');
  });

  it('uses the caller label as the button text and title', () => {
    const view = render(
      <AttachmentCard name="plan.docx" taskId="t1" path="plan.docx" openLabel="Open in Loam Docs" onOpen={() => undefined} />,
    );
    const button = within(view.container).getByRole('button');
    expect(button).toHaveTextContent('Open in Loam Docs');
    expect(button).toHaveAttribute('title', 'Open in Loam Docs');
  });

  it('invokes onOpen instead of opening the media URL', () => {
    const onOpen = vi.fn();
    const view = render(
      <AttachmentCard name="plan.docx" taskId="t1" path="plan.docx" openLabel="Open in Loam Docs" onOpen={onOpen} />,
    );
    fireEvent.click(within(view.container).getByRole('button'));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('labels every Craft app for its attachment', () => {
    const labels: Array<[string, string]> = [
      ['plan.docx', 'Open in Loam Docs'],
      ['budget.xlsx', 'Open in Loam Sheets'],
      ['deck.pptx', 'Open in Loam Slides'],
      ['art.png', 'Open in Loam Photo'],
      ['cover.pdf', 'Open in Loam Design'],
    ];
    for (const [name, label] of labels) {
      const view = render(
        <AttachmentCard name={name} taskId="t1" path={name} openLabel={label} onOpen={() => undefined} />,
      );
      expect(within(view.container).getByRole('button')).toHaveTextContent(label);
      view.unmount();
    }
  });
});
