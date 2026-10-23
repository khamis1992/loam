import type React from "react";

export type WorkspaceKind = "video" | "loam-video" | "craft" | "doc" | "sheet" | "slides";

/**
 * Sentinel path for the Workspace panel's always-available "Loam Video" entry.
 * It opens the video studio without a specific file; the attached video to
 * import rides on `WorkspaceOpenTarget.importPath` instead.
 */
export const LOAM_VIDEO_STUDIO_PATH = "__loam_video_studio__";

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