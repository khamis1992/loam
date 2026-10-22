import type React from "react";

export type WorkspaceKind = "video" | "doc" | "sheet" | "slides";

export interface WorkspaceFile {
  taskId: string;
  path: string;
  name: string;
  kind: WorkspaceKind;
  mime?: string;
}

// Owned by the shell session; editor sessions must keep this shape so a richer
// editor can replace ours without changing the panel contract.
export interface WorkspaceEditorProps {
  file: WorkspaceFile;
  /** The task is currently running. */
  live: boolean;
  onSave: (data: Blob | string) => Promise<void>;
  onChatEdit: (instruction: string) => void;
}

export interface WorkspaceEditorDef {
  kind: WorkspaceKind;
  label: string;
  extensions: string[];
  load: () => Promise<{ default: React.ComponentType<WorkspaceEditorProps> }>;
}