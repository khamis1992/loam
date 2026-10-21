import type React from "react";

export type WorkspaceKind = "video" | "doc" | "sheet" | "slides";

export interface WorkspaceFile {
  taskId: string;
  path: string;
  name: string;
  kind: WorkspaceKind;
  mime?: string;
}

export interface WorkspaceEditorProps {
  file: WorkspaceFile;
  live: boolean; /* task running */
  onSave: (data: Blob | string) => Promise<void>;
  onChatEdit: (instruction: string) => void;
}

export interface WorkspaceEditorDef {
  kind: WorkspaceKind;
  label: string;
  extensions: string[];
  load: () => Promise<{ default: React.ComponentType<WorkspaceEditorProps> }>;
}
