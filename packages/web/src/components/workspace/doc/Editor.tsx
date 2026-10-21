'use client';

import { FileText } from 'lucide-react';
import type { WorkspaceEditorProps } from '../types';

// Stub created by the workspace shell; replaced by the doc editor session.
export default function DocEditorStub({ file }: WorkspaceEditorProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <FileText className="size-8 text-text-quaternary" />
      <p className="text-sm text-text-tertiary">Preview not available yet</p>
      <p className="max-w-full truncate font-mono text-xs text-text-quaternary">{file.path}</p>
    </div>
  );
}
